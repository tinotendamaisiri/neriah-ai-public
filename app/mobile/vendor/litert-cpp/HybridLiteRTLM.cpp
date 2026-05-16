//
// HybridLiteRTLM.cpp
// react-native-litert-lm
//
// High-performance LLM inference using LiteRT-LM C API.
//
// NOTE: This C++ implementation is used for iOS ONLY.
// Android uses the Kotlin implementation in `android/src/main/java/com/margelo/nitro/dev/litert/litertlm/HybridLiteRTLM.kt`.
// Do not assume changes here will affect Android.
//

#include "HybridLiteRTLM.hpp"




#include <NitroModules/Promise.hpp>
#include <chrono>
#include <stdexcept>
#include <sstream>
#include <sys/stat.h>
#include <cstdio>
#include <unistd.h>
#include <fcntl.h>

#ifdef __APPLE__
#include "IOSDownloadHelper.h"
#include <os/proc.h>
#endif
#include <fstream>
#include <thread>
#include <regex>
#include <pthread.h>
#include <functional>

namespace margelo::nitro::litertlm {

// =============================================================================
// Thread Helper — LiteRT engine operations need >512KB stack (XNNPack, Metal)
// =============================================================================

static void runOnLargeStack(std::function<void()> work, size_t stackSize = 8 * 1024 * 1024) {
  struct Context {
    std::function<void()> fn;
    std::exception_ptr exception;
  };
  Context ctx{std::move(work), nullptr};

  pthread_t thread;
  pthread_attr_t attr;
  pthread_attr_init(&attr);
  pthread_attr_setstacksize(&attr, stackSize);

  int rc = pthread_create(&thread, &attr, [](void* arg) -> void* {
    auto* c = static_cast<Context*>(arg);
    try {
      c->fn();
    } catch (...) {
      c->exception = std::current_exception();
    }
    return nullptr;
  }, &ctx);
  pthread_attr_destroy(&attr);
  if (rc != 0) {
    throw std::runtime_error("Failed to create large-stack thread (errno: " + std::to_string(rc) + ")");
  }
  pthread_join(thread, nullptr);

  if (ctx.exception) {
    std::rethrow_exception(ctx.exception);
  }
}

// =============================================================================
// JSON Helpers
// =============================================================================

std::string HybridLiteRTLM::escapeJson(const std::string& input) {
  std::string output;
  output.reserve(input.size() + 16);
  for (char c : input) {
    switch (c) {
      case '"':  output += "\\\""; break;
      case '\\': output += "\\\\"; break;
      case '\n': output += "\\n"; break;
      case '\r': output += "\\r"; break;
      case '\t': output += "\\t"; break;
      case '\b': output += "\\b"; break;
      case '\f': output += "\\f"; break;
      default:   output += c; break;
    }
  }
  return output;
}

std::string HybridLiteRTLM::buildTextMessageJson(const std::string& text) {
  return "{\"role\":\"user\",\"content\":\"" + escapeJson(text) + "\"}";
}

std::string HybridLiteRTLM::buildImageMessageJson(const std::string& text, const std::string& imagePath) {
  return "{\"role\":\"user\",\"content\":["
         "{\"type\":\"text\",\"text\":\"" + escapeJson(text) + "\"},"
         "{\"type\":\"image\",\"path\":\"" + escapeJson(imagePath) + "\"}"
         "]}";
}

std::string HybridLiteRTLM::buildAudioMessageJson(const std::string& text, const std::string& audioPath) {
  return "{\"role\":\"user\",\"content\":["
         "{\"type\":\"text\",\"text\":\"" + escapeJson(text) + "\"},"
         "{\"type\":\"audio\",\"path\":\"" + escapeJson(audioPath) + "\"}"
         "]}";
}

/**
 * Strip Gemma / LiteRT-LM control tokens from model output.
 * The iOS C API returns raw model text including stop/turn markers
 * that the Android Kotlin SDK strips automatically.
 */
static std::string stripControlTokens(const std::string& text) {
  static const char* tokens[] = {
    "<end_of_turn>",
    "<start_of_turn>model",
    "<start_of_turn>user",
    "<start_of_turn>",
    "<eos>",
  };
  std::string result = text;
  for (auto* tok : tokens) {
    std::string t(tok);
    size_t pos;
    while ((pos = result.find(t)) != std::string::npos) {
      result.erase(pos, t.length());
    }
  }
  // Trim leading/trailing whitespace
  size_t start = result.find_first_not_of(" \t\n\r");
  if (start == std::string::npos) return "";
  size_t end = result.find_last_not_of(" \t\n\r");
  return result.substr(start, end - start + 1);
}

std::string HybridLiteRTLM::extractTextFromResponse(const std::string& jsonResponse) {
  // The C API response JSON is structured as:
  //   {"role":"model","content":[{"type":"text","text":"..."}]}
  // or:
  //   {"role":"model","content":"..."}
  //
  // We use simple string extraction to avoid a JSON library dependency.
  
  // Try array format first: find "text":"..." after "type":"text"
  std::string textMarker = "\"text\":\"";
  size_t pos = jsonResponse.find("\"type\":\"text\"");
  if (pos != std::string::npos) {
    pos = jsonResponse.find(textMarker, pos);
    if (pos != std::string::npos) {
      pos += textMarker.length();
      std::string result;
      result.reserve(jsonResponse.size() - pos);
      for (size_t i = pos; i < jsonResponse.size(); i++) {
        if (jsonResponse[i] == '\\' && i + 1 < jsonResponse.size()) {
          char next = jsonResponse[i + 1];
          if (next == '"') { result += '"'; i++; }
          else if (next == '\\') { result += '\\'; i++; }
          else if (next == 'n') { result += '\n'; i++; }
          else if (next == 'r') { result += '\r'; i++; }
          else if (next == 't') { result += '\t'; i++; }
          else { result += jsonResponse[i]; }
        } else if (jsonResponse[i] == '"') {
          break;  // End of the text value
        } else {
          result += jsonResponse[i];
        }
      }
      return stripControlTokens(result);
    }
  }
  
  // Try simple string format: "content":"..."
  std::string contentMarker = "\"content\":\"";
  pos = jsonResponse.find(contentMarker);
  if (pos != std::string::npos) {
    pos += contentMarker.length();
    std::string result;
    for (size_t i = pos; i < jsonResponse.size(); i++) {
      if (jsonResponse[i] == '\\' && i + 1 < jsonResponse.size()) {
        char next = jsonResponse[i + 1];
        if (next == '"') { result += '"'; i++; }
        else if (next == '\\') { result += '\\'; i++; }
        else if (next == 'n') { result += '\n'; i++; }
        else { result += jsonResponse[i]; }
      } else if (jsonResponse[i] == '"') {
        break;
      } else {
        result += jsonResponse[i];
      }
    }
    return stripControlTokens(result);
  }
  
  // Fallback: return full response (still strip control tokens)
  return stripControlTokens(jsonResponse);
}

// =============================================================================
// Conversation Management
// =============================================================================

void HybridLiteRTLM::createNewConversation() {
#ifdef __APPLE__
  if (!engine_) {
    throw std::runtime_error("Cannot create conversation: engine not initialized");
  }

  // Clean up previous session
  if (session_) {
    litert_lm_session_delete(session_);
    session_ = nullptr;
  }
  // Conversation pointers stay nullptr on iOS — see comment block below.

  // We deliberately skip litert_lm_conversation_config_create / _create
  // on iOS. That path constructs a litert::lm::PromptTemplate by reading
  // the model's chat-template metadata (Gemma 4 ships one with vision
  // soft-tokens) and feeding it into re2::RE2(). On our XCFramework —
  // built without vision/audio executor ops — the engine internals
  // partially initialise the multimodal data-processor with a null
  // vision_executor, which writes past the end of an internal buffer
  // and corrupts a libmalloc free-list block. The crash surfaces later,
  // inside re2, as EXC_BREAKPOINT (libmalloc's "memory corruption of
  // free block" trap).
  //
  // The Session API (litert_lm_engine_create_session / generate_content)
  // takes raw InputData and bypasses ConversationConfig + PromptTemplate
  // entirely. We format Gemma 4 turn tokens manually in
  // sendMessageInternal so the model still gets a proper instruction
  // turn structure.
  session_ = litert_lm_engine_create_session(engine_, session_config_);
  if (!session_) {
    throw std::runtime_error("Failed to create LiteRT-LM session");
  }
#endif
}

// =============================================================================
// loadModel
// =============================================================================

std::shared_ptr<Promise<void>> HybridLiteRTLM::loadModel(
    const std::string& modelPath,
    const std::optional<LLMConfig>& config) {
  return Promise<void>::async([this, modelPath, config]() {
    runOnLargeStack([&]() {
      loadModelInternal(modelPath, config);
    });
  });
}

void HybridLiteRTLM::loadModelInternal(
    const std::string& modelPath,
    const std::optional<LLMConfig>& config) {
  
  std::lock_guard<std::mutex> lock(mutex_);
  
  if (isLoaded_) {
    close();
  }
  
  if (config.has_value()) {
    if (config->backend.has_value()) {
      backend_ = config->backend.value();
    }
    if (config->temperature.has_value()) {
      temperature_ = config->temperature.value();
    }
    if (config->topK.has_value()) {
      topK_ = config->topK.value();
    }
    if (config->topP.has_value()) {
      topP_ = config->topP.value();
    }
    if (config->maxTokens.has_value()) {
      maxTokens_ = config->maxTokens.value();
    }
    if (config->systemPrompt.has_value()) {
      systemPrompt_ = config->systemPrompt.value();
    }
  }
  
#ifdef __APPLE__
  // Set log verbosity: 2=WARNING (production), 0=INFO (debug)
  litert_lm_set_min_log_level(2);

  auto backendStr = [](Backend b) -> const char* {
    switch (b) {
      case Backend::GPU: return "gpu";
      case Backend::NPU: return "gpu"; // NPU not available on iOS, use GPU
      default: return "cpu";
    }
  };
  
  // Per-attempt diagnostics. Each tryCreateEngine call appends a labelled
  // line: which backend combination, whether settings_create or engine_
  // create returned null, and any ABSL_LOG output that landed on stderr
  // during the call. Crucial for figuring out *why* the engine refuses
  // to initialise — the upstream C library swallows error context and
  // litert_lm_get_last_error() isn't exported in our XCFramework.
  std::string attemptLog;

  auto tryCreateEngine = [&](const char* backend,
                             const char* visionBackend,
                             const char* audioBackend) -> bool {
    // ── Begin stderr capture ───────────────────────────────────────────────
    // Redirect stderr to a pipe so ABSL_LOG / fprintf calls inside the
    // upstream C library can be drained back to our diagnostic string.
    // We restore stderr unconditionally in cleanup() below so that even
    // if the C call crashes/aborts mid-flight (it shouldn't but defense
    // in depth), the process's stderr is back to normal afterwards.
    // Use ::-prefixed syscalls because some unqualified names (close, read)
    // collide with C++ stream member functions imported into this scope by
    // upstream headers — Xcode flags them as "too many arguments to
    // function call, expected 0, have 1".
    int saved_stderr = ::dup(STDERR_FILENO);
    int pipe_fds[2] = {-1, -1};
    bool capture_active = false;
    if (saved_stderr >= 0 && ::pipe(pipe_fds) == 0) {
      // Make the read end non-blocking so we never hang draining.
      int flags = ::fcntl(pipe_fds[0], F_GETFL, 0);
      if (flags >= 0) ::fcntl(pipe_fds[0], F_SETFL, flags | O_NONBLOCK);
      if (::dup2(pipe_fds[1], STDERR_FILENO) >= 0) {
        capture_active = true;
      }
    }

    auto cleanup_stderr = [&]() -> std::string {
      if (!capture_active) {
        if (saved_stderr >= 0) ::close(saved_stderr);
        if (pipe_fds[0] >= 0) ::close(pipe_fds[0]);
        if (pipe_fds[1] >= 0) ::close(pipe_fds[1]);
        return "";
      }
      // Make sure any buffered stderr writes are flushed to our pipe before
      // we restore the real stderr.
      fflush(stderr);
      ::dup2(saved_stderr, STDERR_FILENO);
      ::close(saved_stderr);
      ::close(pipe_fds[1]);
      // Drain. Bounded read because some absl logs are noisy and we don't
      // want to dump kilobytes into the JS-facing error string.
      std::string captured;
      char buf[2048];
      ssize_t n;
      while ((n = ::read(pipe_fds[0], buf, sizeof(buf) - 1)) > 0) {
        buf[n] = '\0';
        captured += buf;
        if (captured.size() > 1500) {
          captured.resize(1500);
          captured += "…(truncated)";
          break;
        }
      }
      ::close(pipe_fds[0]);
      // Strip trailing whitespace / newlines that pollute the JS string.
      while (!captured.empty() &&
             (captured.back() == '\n' || captured.back() == '\r' ||
              captured.back() == ' ')) {
        captured.pop_back();
      }
      return captured;
    };

    // Compose a label for this attempt, even before making any C calls,
    // so the diag string clearly shows what was tried.
    std::string label = std::string("backend=") + (backend ? backend : "null") +
                        " vision=" + (visionBackend ? visionBackend : "null") +
                        " audio=" + (audioBackend ? audioBackend : "null");

    auto* settings = litert_lm_engine_settings_create(
      modelPath.c_str(),
      backend,
      visionBackend,
      audioBackend
    );

    if (!settings) {
      std::string captured = cleanup_stderr();
      attemptLog += "\n[" + label + "] settings_create returned null";
      if (!captured.empty()) attemptLog += " | stderr: " + captured;
      return false;
    }

    // Do NOT call set_max_num_tokens here. The C-API setting is the engine
    // *context length* (KV-cache size in tokens), NOT a generation cap.
    // Hard-coding it to e.g. 1024 caps the KV-cache slot below what the
    // Gemma 4 E2B prefill graph expects, and the magic-number remap then
    // wires a context-dim of 1024 into a graph compiled for a longer
    // context. The first prefill invocation then trips
    //   dynamic_update_slice.cc:70
    //     SizeOfDimension(update, i) <= SizeOfDimension(operand, i)
    // because the prefill chunk is bigger than the (capped) cache slot.
    //
    // Default is 0 = "let the magic-number heuristic pick", which reads
    // the model's compiled context magic and rounds it down to the largest
    // multiple of 256. That matches what `litert_lm_main` does by default
    // and is what every published Gemma 4 example assumes.
    //
    // Output-token cap belongs on the session (set_max_output_tokens), not
    // here — that one we still set further down where session_config_ is
    // built.

    // No benchmark mode — adds extra logging and (on some paths) wires
    // is_benchmark into AdvancedSettings, which we don't want in production.

    // prefill_chunk_size only takes effect on the *dynamic* CPU executor
    // (LlmLiteRtCompiledModelExecutorDynamic). Gemma 4 ships as a static
    // model with fixed-shape prefill signatures, so this is a no-op for it
    // and we leave it at the C-API default (-1 = no chunking). Setting an
    // arbitrary value here used to seem like the fix for the
    // DYNAMIC_UPDATE_SLICE error, but the real issue was max_num_tokens
    // above; chunk_size never mattered for static models.

    // Set cache directory to the same directory as the model file
    std::string cacheDir = modelPath.substr(0, modelPath.find_last_of('/'));
    litert_lm_engine_settings_set_cache_dir(settings, cacheDir.c_str());

    engine_ = litert_lm_engine_create(settings);
    litert_lm_engine_settings_delete(settings);

    std::string captured = cleanup_stderr();
    if (engine_ == nullptr) {
      attemptLog += "\n[" + label + "] engine_create returned null";
      if (!captured.empty()) attemptLog += " | stderr: " + captured;
      return false;
    }
    // Success — note any captured stderr (often informational, not errors)
    // for later analysis if anyone is reading the log.
    return true;
  };

  // Text-only mode: pass nullptr for vision and audio. The only inference
  // call sites in the JS layer are sendMessage() / sendMessageAsync()
  // (text in, text out). Skipping multimodal executors avoids the
  // "iOS XCFramework lacks vision/audio ops" failure path entirely on
  // engines that still want to compile those executors eagerly at init
  // (engine_impl.cc:340/348 only creates them when settings have value).
  const char* primaryBackend = backendStr(backend_);
  if (!tryCreateEngine(primaryBackend, nullptr, nullptr)) {
    if (backend_ != Backend::CPU && tryCreateEngine("cpu", nullptr, nullptr)) {
      backend_ = Backend::CPU;
    }
  }
  
  if (!engine_) {
    // Collect diagnostic info
    std::string diag = " | Diagnostics: ";
    struct stat st;
    if (stat(modelPath.c_str(), &st) == 0) {
      diag += "File size: " + std::to_string(st.st_size) + " bytes";
    } else {
      diag += "Failed to stat file (errno: " + std::to_string(errno) + ")";
    }
    
    FILE* f = fopen(modelPath.c_str(), "rb");
    if (f) {
      diag += ", Readable: YES";
      fclose(f);
    } else {
      diag += ", Readable: NO (errno: " + std::to_string(errno) + ")";
    }
    
    // litert_lm_get_last_error not available in this build — we capture
    // ABSL_LOG output via stderr redirect inside tryCreateEngine instead,
    // and append it here.
    if (!attemptLog.empty()) {
      diag += " | Attempts:" + attemptLog;
    }

    throw std::runtime_error(
      "Failed to create LiteRT-LM engine. Tried backend '" +
      std::string(primaryBackend) + "' and CPU fallback. Model path: " + modelPath + diag);
  }
  
  session_config_ = litert_lm_session_config_create();
  if (session_config_) {
    litert_lm_session_config_set_max_output_tokens(session_config_, static_cast<int>(maxTokens_));
    
    LiteRtLmSamplerParams sampler{};
    sampler.type = kLiteRtLmSamplerTypeTopP;
    sampler.top_k = static_cast<int32_t>(topK_);
    sampler.top_p = static_cast<float>(topP_);
    sampler.temperature = static_cast<float>(temperature_);
    sampler.seed = 0;
    litert_lm_session_config_set_sampler_params(session_config_, &sampler);
  }
  
  createNewConversation();
#endif
  
  isLoaded_ = true;
  history_.clear();
  lastStats_ = GenerationStats{0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
}

// =============================================================================
// sendMessage — Blocking text inference
// =============================================================================

std::shared_ptr<Promise<std::string>> HybridLiteRTLM::sendMessage(const std::string& message) {
  return Promise<std::string>::async([this, message]() -> std::string {
    std::string result;
    runOnLargeStack([&]() {
      result = sendMessageInternal(message);
    });
    return result;
  });
}

std::string HybridLiteRTLM::sendMessageInternal(const std::string& message) {
  std::lock_guard<std::mutex> lock(mutex_);
  ensureLoaded();

  auto startTime = std::chrono::steady_clock::now();
  std::string result;

#ifdef __APPLE__
  if (!session_) {
    throw std::runtime_error("LiteRT-LM: session not created — call loadModel() first");
  }

  // Wrap user input in Gemma 4 turn tokens. The Session API doesn't
  // apply the model's chat template (that's the very thing we're
  // skipping to avoid the iOS re2 crash), so the wrapper has to format
  // the instruction turn explicitly. Single-turn instruction following
  // is the only mode the JS layer uses (offline homework grading); no
  // multi-turn history needed.
  std::string formatted;
  if (!systemPrompt_.empty()) {
    formatted  = "<start_of_turn>system\n" + systemPrompt_ + "<end_of_turn>\n";
  }
  formatted   += "<start_of_turn>user\n" + message + "<end_of_turn>\n";
  formatted   += "<start_of_turn>model\n";

  // Rebuild the session for every call. The Session API has no
  // reset / clear-turn function, so a session that's already done
  // one prefill (or one that errored mid-flight, like our earlier
  // DYNAMIC_UPDATE_SLICE failure) won't accept a new turn — it
  // throws "Prefill turn prefill:0 already started". Recreating is
  // ~tens of ms; total inference is multi-second, so the overhead
  // is negligible and we get guaranteed clean state.
  if (session_) {
    litert_lm_session_delete(session_);
    session_ = nullptr;
  }
  session_ = litert_lm_engine_create_session(engine_, session_config_);
  if (!session_) {
    throw std::runtime_error("LiteRT-LM: failed to create session before generate");
  }

  LiteRtLmInputData input{};
  input.type = kLiteRtLmInputDataTypeText;
  input.data = formatted.c_str();
  input.size = formatted.size();

  // Capture stderr while generate_content runs so any ABSL_LOG /
  // tflite / kleidiAI error messages get surfaced back to JS land.
  // Without this the C call just returns null with no context and the
  // user sees a generic "generate_content failed" with no clue
  // whether it was OOM, an oversized prompt, a tokenizer issue, or
  // something else.
  int saved_stderr = ::dup(STDERR_FILENO);
  int pipe_fds[2] = {-1, -1};
  bool capture_active = false;
  if (saved_stderr >= 0 && ::pipe(pipe_fds) == 0) {
    int flags = ::fcntl(pipe_fds[0], F_GETFL, 0);
    if (flags >= 0) ::fcntl(pipe_fds[0], F_SETFL, flags | O_NONBLOCK);
    if (::dup2(pipe_fds[1], STDERR_FILENO) >= 0) capture_active = true;
  }

  auto* responses = litert_lm_session_generate_content(session_, &input, 1);

  std::string captured;
  if (capture_active) {
    fflush(stderr);
    ::dup2(saved_stderr, STDERR_FILENO);
    ::close(saved_stderr);
    ::close(pipe_fds[1]);
    char buf[2048];
    ssize_t n;
    while ((n = ::read(pipe_fds[0], buf, sizeof(buf) - 1)) > 0) {
      buf[n] = '\0';
      captured += buf;
      if (captured.size() > 1500) {
        captured.resize(1500);
        captured += "…(truncated)";
        break;
      }
    }
    ::close(pipe_fds[0]);
    while (!captured.empty() &&
           (captured.back() == '\n' || captured.back() == '\r' ||
            captured.back() == ' ')) {
      captured.pop_back();
    }
  } else if (saved_stderr >= 0) {
    ::close(saved_stderr);
    if (pipe_fds[0] >= 0) ::close(pipe_fds[0]);
    if (pipe_fds[1] >= 0) ::close(pipe_fds[1]);
  }

  if (!responses) {
    std::string msg = "LiteRT-LM: generate_content failed (prompt=" +
                      std::to_string(formatted.size()) + " bytes";
    if (!captured.empty()) msg += ", stderr: " + captured;
    msg += ")";
    throw std::runtime_error(msg);
  }

  if (litert_lm_responses_get_num_candidates(responses) > 0) {
    const char* text = litert_lm_responses_get_response_text_at(responses, 0);
    if (text) {
      result = stripControlTokens(std::string(text));
    }
  }
  litert_lm_responses_delete(responses);

  // Benchmark info on Session — best-effort. Some C API builds expose
  // a per-session benchmark accessor; if not available, leave the
  // existing lastStats_ values untouched.
  auto* benchInfo = litert_lm_session_get_benchmark_info(session_);
  if (benchInfo) {
    int numDecodeTurns = litert_lm_benchmark_info_get_num_decode_turns(benchInfo);
    if (numDecodeTurns > 0) {
      int lastIdx = numDecodeTurns - 1;
      lastStats_.completionTokens = static_cast<double>(
        litert_lm_benchmark_info_get_decode_token_count_at(benchInfo, lastIdx));
    }
    litert_lm_benchmark_info_delete(benchInfo);
  }
#else
  // Non-Apple stub
  result = "[iOS only] LiteRT-LM inference not available on this platform.";
#endif
  
  auto endTime = std::chrono::steady_clock::now();
  double latencyMs = std::chrono::duration<double, std::milli>(endTime - startTime).count();
  lastStats_.totalTime = latencyMs / 1000.0;
  
  // Update history
  history_.push_back(Message{Role::USER, message});
  history_.push_back(Message{Role::MODEL, result});
  
  return result;
}

// =============================================================================
// sendMessageAsync — Streaming text inference
// =============================================================================

void HybridLiteRTLM::streamCallbackFn(void* callback_data, const char* chunk,
                                        bool is_final, const char* error_msg) {
  auto* ctx = static_cast<StreamContext*>(callback_data);
  
  if (error_msg) {
    // Error occurred — notify JS and clean up
    ctx->onToken(std::string("Error: ") + error_msg, true);
    delete ctx;
    return;
  }
  
  if (is_final) {
    // Calculate stats
    auto endTime = std::chrono::steady_clock::now();
    double durationMs = std::chrono::duration<double, std::milli>(endTime - ctx->startTime).count();
    
    if (ctx->lastStats && ctx->tokenCount > 0) {
      ctx->lastStats->completionTokens = static_cast<double>(ctx->tokenCount);
      ctx->lastStats->totalTime = durationMs / 1000.0;
      ctx->lastStats->tokensPerSecond = (ctx->tokenCount / durationMs) * 1000.0;
    }
    
    // Update history (thread-safe)
    {
      std::lock_guard<std::mutex> lock(*ctx->historyMutex);
      ctx->history->push_back(Message{Role::USER, ctx->userMessage});
      ctx->history->push_back(Message{Role::MODEL, ctx->fullResponse});
    }
    
    ctx->onToken("", true);
    delete ctx;
    return;
  }
  
  if (chunk) {
    std::string token(chunk);
    // Filter out Gemma control tokens from streamed chunks
    std::string cleaned = stripControlTokens(token);
    ctx->fullResponse += cleaned;
    ctx->tokenCount++;
    if (!cleaned.empty()) {
      ctx->onToken(cleaned, false);
    }
  }
}

void HybridLiteRTLM::sendMessageAsync(
    const std::string& message,
    const std::function<void(const std::string&, bool)>& onToken) {
  
  // Copy values for the background thread (avoid use-after-free)
  auto onTokenCopy = onToken;
  auto messageCopy = message;
  
  // Capture shared state safely — use unique_ptr to prevent leaks
  auto ctxOwner = std::make_unique<StreamContext>();
  ctxOwner->onToken = std::move(onTokenCopy);
  ctxOwner->fullResponse = "";
  ctxOwner->history = &history_;
  ctxOwner->historyMutex = &mutex_;
  ctxOwner->userMessage = messageCopy;
  ctxOwner->lastStats = &lastStats_;
  ctxOwner->startTime = std::chrono::steady_clock::now();
  ctxOwner->tokenCount = 0;
  
#ifdef __APPLE__
  ensureLoaded();
  if (!session_) {
    throw std::runtime_error("LiteRT-LM: session not created — call loadModel() first");
  }

  // Format Gemma 4 turn tokens manually — same reasoning as
  // sendMessageInternal: Session API skips the prompt-template machinery
  // (which crashes on iOS for vision-aware Gemma 4), so the wrapper
  // formats the chat turns itself.
  std::string formatted;
  if (!systemPrompt_.empty()) {
    formatted  = "<start_of_turn>system\n" + systemPrompt_ + "<end_of_turn>\n";
  }
  formatted   += "<start_of_turn>user\n" + messageCopy + "<end_of_turn>\n";
  formatted   += "<start_of_turn>model\n";

  // Pin the formatted prompt on the StreamContext so its underlying
  // buffer outlives the C call (InputData.data is a borrowed pointer).
  ctxOwner->promptBuffer = std::move(formatted);

  // Same session rebuild as sendMessageInternal — Session API has no
  // reset, so a prior turn (especially one that errored mid-flight)
  // would block this call with "Prefill turn already started".
  if (session_) {
    litert_lm_session_delete(session_);
    session_ = nullptr;
  }
  session_ = litert_lm_engine_create_session(engine_, session_config_);
  if (!session_) {
    throw std::runtime_error("LiteRT-LM: failed to create session before stream");
  }

  // Release ownership — the C callback now owns the context via raw pointer.
  // streamCallbackFn will delete it when done or on error.
  StreamContext* ctx = ctxOwner.release();

  LiteRtLmInputData input{};
  input.type = kLiteRtLmInputDataTypeText;
  input.data = ctx->promptBuffer.c_str();
  input.size = ctx->promptBuffer.size();

  // Wrap the initial engine call in runOnLargeStack for consistency
  // with all other engine entry points (XNNPack needs >512KB stack).
  runOnLargeStack([&]() {
    int result = litert_lm_session_generate_content_stream(
      session_, &input, 1, streamCallbackFn, ctx);

    if (result != 0) {
      delete ctx;
      throw std::runtime_error("LiteRT-LM: Failed to start streaming inference");
    }
  });
#else
  // Non-Apple stub
  ctxOwner->onToken("[iOS only] Streaming not available on this platform.", true);
  // ctxOwner auto-deleted by unique_ptr
#endif
}

// =============================================================================
// sendMessageWithImage — Multimodal (vision)
// =============================================================================

std::shared_ptr<Promise<std::string>> HybridLiteRTLM::sendMessageWithImage(
    const std::string& message,
    const std::string& imagePath) {
  return Promise<std::string>::async([this, message, imagePath]() -> std::string {
    std::string result;
    runOnLargeStack([&]() {
      result = sendMessageWithImageInternal(message, imagePath);
    });
    return result;
  });
}

std::string HybridLiteRTLM::sendMessageWithImageInternal(
    const std::string& message,
    const std::string& imagePath) {
  
  std::lock_guard<std::mutex> lock(mutex_);
  ensureLoaded();
  
  auto startTime = std::chrono::steady_clock::now();
  std::string result;
  
#ifdef __APPLE__
  // Verify image exists
  std::ifstream imageFile(imagePath);
  if (!imageFile.good()) {
    throw std::runtime_error("Image file not found: " + imagePath);
  }
  imageFile.close();
  
  // Build multimodal message JSON — the C API handles image preprocessing
  std::string msgJson = buildImageMessageJson(message, imagePath);
  
  auto* response = litert_lm_conversation_send_message(
    conversation_, msgJson.c_str(), nullptr);
  
  if (!response) {
    std::string errMsg = "LiteRT-LM: sendMessageWithImage failed";
    // litert_lm_get_last_error not available in this build
    throw std::runtime_error(errMsg);
  }
  
  const char* responseStr = litert_lm_json_response_get_string(response);
  if (responseStr) {
    result = extractTextFromResponse(std::string(responseStr));
  }
  litert_lm_json_response_delete(response);
#else
  result = "[iOS only] Vision inference not available on this platform.";
#endif
  
  auto endTime = std::chrono::steady_clock::now();
  lastStats_.totalTime = std::chrono::duration<double>(endTime - startTime).count();
  
  history_.push_back(Message{Role::USER, message + " [image: " + imagePath + "]"});
  history_.push_back(Message{Role::MODEL, result});
  
  return result;
}

// =============================================================================
// sendMessageWithAudio — Multimodal (audio)
// =============================================================================

std::shared_ptr<Promise<std::string>> HybridLiteRTLM::sendMessageWithAudio(
    const std::string& message,
    const std::string& audioPath) {
  return Promise<std::string>::async([this, message, audioPath]() -> std::string {
    std::string result;
    runOnLargeStack([&]() {
      result = sendMessageWithAudioInternal(message, audioPath);
    });
    return result;
  });
}

std::string HybridLiteRTLM::sendMessageWithAudioInternal(
    const std::string& message,
    const std::string& audioPath) {
  
  std::lock_guard<std::mutex> lock(mutex_);
  ensureLoaded();
  
  auto startTime = std::chrono::steady_clock::now();
  std::string result;
  
#ifdef __APPLE__
  std::ifstream audioFile(audioPath);
  if (!audioFile.good()) {
    throw std::runtime_error("Audio file not found: " + audioPath);
  }
  audioFile.close();
  
  std::string msgJson = buildAudioMessageJson(message, audioPath);
  
  auto* response = litert_lm_conversation_send_message(
    conversation_, msgJson.c_str(), nullptr);
  
  if (!response) {
    std::string errMsg = "LiteRT-LM: sendMessageWithAudio failed";
    // litert_lm_get_last_error not available in this build
    throw std::runtime_error(errMsg);
  }
  
  const char* responseStr = litert_lm_json_response_get_string(response);
  if (responseStr) {
    result = extractTextFromResponse(std::string(responseStr));
  }
  litert_lm_json_response_delete(response);
#else
  result = "[iOS only] Audio inference not available on this platform.";
#endif
  
  auto endTime = std::chrono::steady_clock::now();
  lastStats_.totalTime = std::chrono::duration<double>(endTime - startTime).count();
  
  history_.push_back(Message{Role::USER, message + " [audio: " + audioPath + "]"});
  history_.push_back(Message{Role::MODEL, result});
  
  return result;
}

// =============================================================================
// downloadModel — Download model from URL
// =============================================================================

std::shared_ptr<Promise<std::string>> HybridLiteRTLM::downloadModel(
    const std::string& url,
    const std::string& fileName,
    const std::optional<std::function<void(double)>>& onProgress) {
  return Promise<std::string>::async([url, fileName, onProgress]() -> std::string {
#ifdef __APPLE__
    return litert_lm::downloadModelFile(url, fileName, onProgress);
#else
    // Non-Apple platforms: not supported from C++ (Android uses Kotlin)
    throw std::runtime_error("Download not available on this platform. Use the Kotlin implementation.");
#endif
  });
}

std::shared_ptr<Promise<void>> HybridLiteRTLM::deleteModel(const std::string& fileName) {
  return Promise<void>::async([fileName]() {
    std::string path;
#ifdef __APPLE__
    // Match the path used by IOSDownloadHelper: ~/Library/Caches/litert_models/
    const char* home = getenv("HOME");
    if (home) {
      path = std::string(home) + "/Library/Caches/litert_models/" + fileName;
    }
#else
    path = "/tmp/" + fileName;
#endif
    if (!path.empty()) {
      std::remove(path.c_str());
    }
  });
}

// =============================================================================
// getHistory
// =============================================================================

std::vector<Message> HybridLiteRTLM::getHistory() {
  std::lock_guard<std::mutex> lock(mutex_);
  return history_;
}

// =============================================================================
// resetConversation
// =============================================================================

void HybridLiteRTLM::resetConversation() {
  std::lock_guard<std::mutex> lock(mutex_);
  
  history_.clear();
  lastStats_ = GenerationStats{0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
  
#ifdef __APPLE__
  if (isLoaded_ && engine_) {
    createNewConversation();
  }
#endif
}

// =============================================================================
// isReady
// =============================================================================

bool HybridLiteRTLM::isReady() {
  std::lock_guard<std::mutex> lock(mutex_);
  return isLoaded_;
}

// =============================================================================
// getStats
// =============================================================================

GenerationStats HybridLiteRTLM::getStats() {
  std::lock_guard<std::mutex> lock(mutex_);
  return lastStats_;
}

// =============================================================================
// getMemoryUsage — Uses Mach APIs for iOS process memory
// =============================================================================

MemoryUsage HybridLiteRTLM::getMemoryUsage() {
  double nativeHeapBytes = 0;
  double residentBytes = 0;
  double availableBytes = 0;
  bool isLowMemory = false;
  
#ifdef __APPLE__
  // Get app process memory (resident set size)
  struct mach_task_basic_info info;
  mach_msg_type_number_t count = MACH_TASK_BASIC_INFO_COUNT;
  
  kern_return_t kr = task_info(mach_task_self(),
                               MACH_TASK_BASIC_INFO,
                               (task_info_t)&info,
                               &count);
  
  if (kr == KERN_SUCCESS) {
    residentBytes = static_cast<double>(info.resident_size);
    // On iOS, mach_task_basic_info doesn't separate heap from RSS.
    // Use resident_size_max as a proxy for peak native allocation.
    nativeHeapBytes = static_cast<double>(info.resident_size);
  }
  
  // Use os_proc_available_memory() (iOS 13+) for accurate Jetsam headroom.
  // This reports how much memory the process can still allocate before
  // the system kills it — far more accurate than total_physical - process_rss.
  availableBytes = static_cast<double>(os_proc_available_memory());
  
  // Low memory threshold (~200MB available)
  isLowMemory = availableBytes < 200.0 * 1024.0 * 1024.0;
#endif
  
  return MemoryUsage{
    nativeHeapBytes,            // nativeHeapBytes (RSS as proxy on iOS)
    residentBytes,              // residentBytes  
    availableBytes,             // availableMemoryBytes
    isLowMemory                 // isLowMemory
  };
}

// =============================================================================
// close — Clean up all LiteRT-LM resources
// =============================================================================

void HybridLiteRTLM::close() {
  // Note: Don't lock here if called from destructor (mutex may be destroyed)
  // The caller (loadModel, destructor) should handle locking.
  
  isLoaded_ = false;
  history_.clear();
  
#ifdef __APPLE__
  if (session_) {
    litert_lm_session_delete(session_);
    session_ = nullptr;
  }
  if (conversation_) {
    litert_lm_conversation_delete(conversation_);
    conversation_ = nullptr;
  }
  if (conv_config_) {
    litert_lm_conversation_config_delete(conv_config_);
    conv_config_ = nullptr;
  }
  if (session_config_) {
    litert_lm_session_config_delete(session_config_);
    session_config_ = nullptr;
  }
  if (engine_) {
    litert_lm_engine_delete(engine_);
    engine_ = nullptr;
  }
#endif
  
  lastStats_ = GenerationStats{0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
}

} // namespace margelo::nitro::litertlm
