require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "react-native-litert-lm"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]
  s.platforms    = { :ios => "15.0" }
  s.source       = { :git => package["repository"]["url"], :tag => "#{s.version}" }

  s.swift_version = '5.0'

  s.source_files = [
    # Implementation (C++)
    "cpp/**/*.{hpp,cpp,h}",
    # Autolinking (Objective-C++)
    "ios/**/*.{m,mm}",
    # Nitrogen generated iOS bridge
    "nitrogen/generated/ios/**/*.{mm,swift}",
  ]

  # Exclude Android-only JNI files from iOS build
  s.exclude_files = [
    "cpp/cpp-adapter.cpp",
  ]

  # Prebuilt LiteRT-LM C engine (static library built from Bazel //c:engine target).
  # Downloaded from GitHub releases by postinstall.js, or built locally via:
  #   scripts/build-ios-engine.sh
  s.vendored_frameworks = 'ios/Frameworks/LiteRTLM.xcframework'

  s.pod_target_xcconfig = {
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20',
    'CLANG_CXX_LIBRARY' => 'libc++',
    'HEADER_SEARCH_PATHS' => [
      '"$(PODS_TARGET_SRCROOT)/cpp"',
      '"$(PODS_TARGET_SRCROOT)/cpp/include"',
      '"$(PODS_TARGET_SRCROOT)/nitrogen/generated/shared/c++"',
      '"$(PODS_TARGET_SRCROOT)/nitrogen/generated/ios"',
    ].join(' '),
  }

  # Force-loading the entire LiteRTLM framework binary causes
  # duplicate-symbol errors because the framework is also pulled in by
  # CocoaPods auto-linking, so the same archive ends up in the link
  # twice. Instead we extract just engine_impl.o (the only .o we need
  # to keep — its static initializer LITERT_LM_REGISTER_ENGINE
  # populates EngineFactory at startup) into a tiny per-slice archive
  # libengine_init.a, vendored under ios/EngineInit/<slice>/, and
  # force-load that. The full framework still links lazily as normal.
  #
  # Without this, the linker strips engine_impl.o because nothing
  # outside the framework references its symbols (they're all weak),
  # leaving EngineFactory empty — engine_create then returns NOT_FOUND
  # at runtime ("Engine type not found: 1").
  #
  # SDK-conditional OTHER_LDFLAGS picks the matching slice for device
  # vs simulator builds.
  # $(PODS_TARGET_SRCROOT) is only set on pod-target xcconfigs, not on
  # the consuming app target — so we reach back into node_modules via
  # $(PODS_ROOT)/../../node_modules/react-native-litert-lm/, the same
  # path CocoaPods itself uses for FRAMEWORK_SEARCH_PATHS on this pod.
  s.user_target_xcconfig = {
    'OTHER_LDFLAGS[sdk=iphoneos*]'        => '$(inherited) -force_load $(PODS_ROOT)/../../node_modules/react-native-litert-lm/ios/EngineInit/ios-arm64/libengine_init.a',
    'OTHER_LDFLAGS[sdk=iphonesimulator*]' => '$(inherited) -force_load $(PODS_ROOT)/../../node_modules/react-native-litert-lm/ios/EngineInit/ios-arm64-simulator/libengine_init.a',
  }

  # Load nitrogen autolinking
  load 'nitrogen/generated/ios/LiteRTLM+autolinking.rb'
  add_nitrogen_files(s)

  # Core React Native dependencies
  s.dependency 'React-jsi'
  s.dependency 'React-callinvoker'
  s.dependency 'ReactCommon/turbomodule/core'

  # Apple frameworks needed by LiteRT-LM engine
  # Metal/MPS: GPU inference, Accelerate: BLAS/LAPACK, CoreML: delegate
  s.frameworks = ['Metal', 'MetalPerformanceShaders', 'Accelerate', 'CoreML', 'CoreGraphics']
  s.libraries = ['c++']

  install_modules_dependencies(s)
end
