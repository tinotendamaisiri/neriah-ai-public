// src/types/index.ts
// Shared TypeScript types mirroring backend/shared/models.py.
// Keep in sync with the backend Pydantic models.

// ── Enums ─────────────────────────────────────────────────────────────────────

export type EducationLevel =
  | 'grade_1' | 'grade_2' | 'grade_3' | 'grade_4'
  | 'grade_5' | 'grade_6' | 'grade_7'
  | 'form_1' | 'form_2' | 'form_3' | 'form_4' | 'form_5' | 'form_6'
  | 'tertiary';

export type SubscriptionStatus = 'active' | 'trial' | 'expired' | 'suspended';

export type GradingVerdictEnum = 'correct' | 'incorrect' | 'partial';

export type UserRole = 'teacher' | 'student';

// ── Models ────────────────────────────────────────────────────────────────────

export interface School {
  id: string;
  name: string;
  city: string;
  province: string;
  type: 'primary' | 'secondary' | 'tertiary';
}

export interface Teacher {
  id: string;
  phone: string;
  first_name: string;
  surname: string;
  email?: string;
  school?: string;
  subscription_status: SubscriptionStatus;
  education_levels_active: EducationLevel[];
  push_token?: string;
  created_at: string;
  role: 'teacher';
}

export interface Class {
  id: string;
  teacher_id: string;
  name: string;
  education_level: EducationLevel;
  curriculum?: 'zimsec' | 'cambridge';
  grade?: string;
  join_code?: string;
  share_analytics: boolean;
  share_rank: boolean;
  student_ids: string[];
  created_at: string;
}

export interface Student {
  id: string;
  class_id: string;
  first_name: string;
  surname: string;
  phone?: string;
  register_number?: string;
  push_token?: string;
  role: 'student';
}

export interface Question {
  number: number;
  question_number?: number;
  question_text?: string;
  answer?: string;
  correct_answer?: string;
  marks: number;
  marking_notes?: string;
}

/** Shape returned by the backend for generated marking scheme questions. */
export interface ReviewQuestion {
  question_number: number;
  question_text: string;
  answer: string;
  marks: number;
  marking_notes?: string | null;
}

export interface AnswerKey {
  id: string;
  class_id: string;
  title: string;
  subject?: string;
  teacher_id?: string;
  education_level?: EducationLevel;
  questions: Question[];
  total_marks?: number;
  open_for_submission: boolean;
  generated: boolean;
  created_at: string;
  due_date?: string;
  status?: string | null; // "pending_setup" = unlabeled auto-created, null/undefined = normal
  /** Short code printed on the slip students copy into their email
   *  subject line ("Code: HW7K2P") so the inbound poller can resolve
   *  the homework directly without fuzzy school/class matching.
   *  Optional because legacy AnswerKey docs from before this field
   *  was added won't have one. */
  submission_code?: string;
}

export interface GradingVerdict {
  question_number: number;
  verdict: GradingVerdictEnum;
  awarded_marks: number;
  max_marks: number;
  feedback?: string;
  /** Backend grading pipeline may populate these; UI shows them in the
   *  edit modal when present and falls back to "—" otherwise. */
  question_text?: string;
  student_answer?: string;
  expected_answer?: string;
  /** Fractions of image dimensions (0.0-1.0) locating the question-number
   *  label on the scanned page. Used by the backend annotator to place the
   *  verdict symbol next to the actual question. Mobile does not currently
   *  render these but forwards them on edit-mark writes. */
  question_x?: number;
  question_y?: number;
}

export interface Mark {
  id: string;
  student_id: string;
  teacher_id: string;
  class_id?: string;
  answer_key_id: string;
  score: number;
  max_score: number;
  percentage?: number;
  marked_image_url: string;
  /** All annotated pages (teacher-visible output), in order. Backend
   *  returns these on get_mark. Mobile uses them to show the same
   *  document UI in GradingDetail as in the post-scan MarkResult flow. */
  annotated_urls?: string[];
  /** All submitted pages (originals), in order. Used as a fallback
   *  when annotated_urls hasn't been populated yet. */
  page_urls?: string[];
  source: 'teacher_scan' | 'student_submission';
  approved: boolean;
  approved_at?: string;
  feedback?: string;
  verdicts: GradingVerdict[];
  manually_edited?: boolean;
  timestamp: string;
}

// ── API response shapes ───────────────────────────────────────────────────────

/** Response from POST /api/mark (teacher scan pipeline) */
export interface MarkResult {
  mark_id: string;
  student_id: string;
  student_name: string;
  score: number;
  max_score: number;
  percentage: number;
  /** First annotated page — kept for legacy callers. Same as `annotated_urls[0]`. */
  marked_image_url: string;
  /** All submitted pages (originals), in order. */
  page_urls?: string[];
  /** All annotated pages (teacher-visible output), in order. */
  annotated_urls?: string[];
  page_count?: number;
  verdicts: GradingVerdict[];
  /** True when this MarkResult came from on-device grading — annotated_urls
   *  point at the original (unannotated) pages, so the UI must draw its own
   *  verdict overlay on top of each image. Also disables the Approve button
   *  because the server doesn't know about local-only marks. Undefined /
   *  false for cloud-graded results. */
  locally_graded?: boolean;
  /** Per-verdict page index — present on offline grades so the overlay
   *  knows which page to draw each symbol on. Optional for cloud grades
   *  (the annotator has already baked them into the image). */
  verdict_page_indices?: number[];
}

/** Response from POST /api/auth/login or /api/auth/register */
export interface OtpSentResponse {
  verification_id: string;
  message: string;
  debug_otp?: string; // DEV ONLY — present when no OTP delivery channel is configured (no Twilio, no WhatsApp template)
}

/** Response from POST /api/auth/verify — user object is nested */
export interface VerifyResponse {
  token: string;
  user: {
    id: string;
    first_name: string;
    surname: string;
    phone: string;
    role: UserRole;
    school?: string;    // teacher only
    class_id?: string;  // student only
  };
}

/** Decoded JWT payload stored in AuthContext */
export interface AuthUser {
  id: string;
  phone: string;
  role: UserRole;
  name?: string;         // full name from backend (teachers)
  title?: string;        // e.g. "Mr", "Dr"
  display_name?: string; // title + name combined, e.g. "Mr Tinotenda Maisiri"
  first_name: string;
  surname: string;
  school?: string;
  class_id?: string;   // student only
  join_code?: string;  // student only — stored when registered via join code
}

// ── Student auth types ────────────────────────────────────────────────────────

/** One match entry from POST /api/auth/student/lookup */
export interface StudentMatch {
  student: {
    id: string;
    first_name: string;
    surname: string;
    register_number?: string;
    class_id: string;
  };
  class: {
    id: string;
    name: string;
    subject?: string;
    education_level: string;
  };
  teacher: {
    first_name: string;
    surname: string;
  };
  school?: string;
}

/** Response from POST /api/auth/student/lookup */
export interface LookupResponse {
  matches: StudentMatch[];
}

/** Response from GET /api/classes/join/{code} */
export interface ClassJoinInfo {
  id: string;
  name: string;
  subject?: string;
  education_level?: string;
  teacher: { first_name: string; surname: string };
}

/** Student-facing: open assignment from GET /api/assignments */
export interface Assignment {
  id: string;
  title?: string;
  subject?: string;
  total_marks?: number;
  education_level?: string;
  created_at?: string;
  due_date?: string;
  open_for_submission?: boolean;
  has_pending_submission?: boolean;
  /** Lifecycle state of the answer key on the teacher side. Drives the
   *  badge the student sees: pending_setup → "Coming soon", closed →
   *  "Closed", anything else → submit/closed based on open_for_submission. */
  status?: 'draft' | 'pending_setup' | 'open' | 'closed' | 'graded' | string;
}

/** Approved mark visible to a student (GET /api/marks/student/{id}) */
export interface StudentMark {
  id: string;
  answer_key_id: string;
  answer_key_title?: string;
  score: number;
  max_score: number;
  percentage?: number;
  marked_image_url?: string;
  source: string;
  approved: boolean;
  feedback?: string;           // overall teacher comment
  manually_edited?: boolean;   // true if teacher edited AI verdicts/feedback
  timestamp: string;
  verdicts?: GradingVerdict[];
  subject?: string;
}

/** Teacher-side view of a student submission (GET /api/submissions) */
export interface TeacherSubmission {
  id: string;
  mark_id: string;
  student_id: string;
  student_name?: string;
  class_id: string;
  class_name?: string;
  answer_key_id: string;
  answer_key_title?: string;
  status: 'pending' | 'graded' | 'approved' | 'graded_pending_approval';
  approved?: boolean;
  submitted_at: string;
  graded_at?: string;
  score?: number;
  max_score?: number;
  marked_image_url?: string;
  source: string;
  verdicts?: GradingVerdict[];
  overall_feedback?: string;
  manually_edited?: boolean;
}

/** Pending or graded submission (GET /api/submissions/student/{id}) */
export interface StudentSubmission {
  mark_id: string;
  answer_key_id: string;
  answer_key_title?: string;
  status: 'pending' | 'graded';
  submitted_at: string;
  graded_at?: string;
  score?: number;
  max_score?: number;
  percentage?: number;
  marked_image_url?: string;
}

/** Per-class summary student row (lightweight — for inline expansion). */
export interface ClassSummaryStudent {
  student_id: string;
  name: string;
  average_score: number;
  submission_count: number;
  trend: 'up' | 'down' | 'stable';
  no_submissions?: boolean;
}

/** Teacher analytics: per-class summary card (GET /api/analytics/classes) */
export interface ClassAnalyticsSummary {
  class_id: string;
  class_name: string;
  education_level: string;
  subject?: string;
  total_students: number;
  homework_count: number;
  total_submissions: number;
  average_score: number;
  recent_trend: 'up' | 'down' | 'stable';
  recent_scores?: number[];
  class_weaknesses_aggregated?: AggregatedWeakness[];
  students?: ClassSummaryStudent[];
  last_activity?: string;
}

/** Topic-aggregated weakness — shared between per-student and per-class analytics. */
export interface AggregatedWeakness {
  topic: string;
  attempts: number;
  correct: number;
  accuracy_pct: number;
  last_seen_at?: string | null;
}

/** Teacher analytics: full class breakdown (GET /api/analytics/class/{class_id}) */
export interface ClassAnalyticsDetail {
  class_id: string;
  class_name: string;
  total_students: number;
  homework_count?: number;
  summary: {
    average_score: number;
    total_submissions: number;
    completion_rate: number;
    improvement_pct: number | null;
  };
  score_distribution: Array<{ range: string; count: number }>;
  performance_over_time: Array<{ homework_title: string; date: string; average_score: number }>;
  students: Array<{
    student_id: string;
    name: string;
    register_number?: string;
    average_score: number;
    submission_count: number;
    trend: 'up' | 'down' | 'stable';
    no_submissions?: boolean;
  }>;
  class_weaknesses_aggregated?: AggregatedWeakness[];
}

/** Teacher analytics: student breakdown (GET /api/analytics/student/{student_id}) */
export interface TeacherStudentAnalyticsData {
  student: {
    id: string;
    name: string;
    register_number?: string;
    average_score: number;
    total_submissions: number;
    first_submission_date?: string;
  };
  performance_over_time: Array<{
    homework_title: string;
    date: string;
    score_pct: number;
    class_average: number;
  }>;
  strengths: Array<{ homework_title: string; score: number; class_average: number }>;
  weaknesses: Array<{ homework_title: string; score: number; class_average: number }>;
  /** Topic-aggregated weakness list — sorted weakest-first, min 2 attempts
   *  per topic. Used by the "Areas they're struggling with" section to show
   *  "Word problems — 30% accuracy (5 attempts)"-style rows. */
  weaknesses_aggregated: Array<{
    topic: string;
    attempts: number;
    correct: number;
    accuracy_pct: number;
    last_seen_at?: string | null;
  }>;
  submissions: Array<{
    id: string;
    homework_title: string;
    date: string;
    score: number;
    max_score: number;
    feedback_preview?: string;
  }>;
}

/** Class analytics visible to student (GET /api/analytics/student-class/{class_id}) */
export interface StudentClassAnalytics {
  enabled: boolean;
  rank_enabled?: boolean;
  student_average?: number;
  class_average?: number;
  student_rank?: number;
  total_students?: number;
  total_assignments_graded?: number;
  trend?: number[];
  per_assignment?: Array<{
    title: string;
    student_score: number;
    class_average: number;
  }>;
  strengths?: string[];
  weaknesses?: string[];
}

// ── Navigation param lists ────────────────────────────────────────────────────

export type AuthStackParamList = {
  RoleSelect: undefined;    // Landing screen — role selection or "sign in"
  Phone: { role?: 'teacher' | 'student' } | undefined;  // Login flow — role gates cross-role login
  OTP: { phone: string; verification_id: string; debug_otp?: string; channel?: 'whatsapp' | 'sms' | 'email' };
  TeacherRegister: undefined;
  StudentRegister: undefined;
};

export type MainTabParamList = {
  Home: undefined;
  Analytics: { class_id?: string } | undefined;
  Assistant: undefined;
  Settings: undefined;
};

/** A single captured (and overlay-cropped) exercise-book page. The teacher
 *  can stage 1-5 of these before submitting for grading. */
export type CapturedPage = {
  id: string;
  uri: string;
  width: number;
  height: number;
  capturedAt: number;
};

export type RootStackParamList = {
  Main: undefined;
  ClassSetup: undefined;
  ClassDetail: { class_id: string; class_name: string; education_level: EducationLevel; curriculum?: 'zimsec' | 'cambridge' };
  TeacherInbox: undefined;
  HomeworkDetail: { answer_key_id: string; class_id: string; class_name: string };
  AddHomework: { class_id?: string; class_name?: string; education_level?: string };
  HomeworkCreated: { answer_key_id: string; class_id: string; class_name: string };
  ReviewScheme: {
    answer_key_id: string;
    class_id: string;
    class_name: string;
    questions: ReviewQuestion[];
    qp_text?: string;
    /** Base64-encoded file for regeneration (avoids multipart boundary issues) */
    qp_file_base64?: string;
    /** MIME type matching qp_file_base64 */
    qp_media_type?: string;
  };
  SetPin: undefined;
  HomeworkList: { class_id: string; class_name: string };
  GradingResults: { answer_key_id?: string; class_id: string; class_name: string; answer_key_title?: string };
  GradingDetail: { mark_id: string; student_name: string; class_name: string; answer_key_title: string };
  Mark: {
    class_id: string;
    class_name: string;
    education_level: EducationLevel;
    answer_key_id?: string;
    /** Set by PageReviewScreen after a successful submit. MarkingScreen
     *  consumes this on focus and runs its existing post-scan logic
     *  (duplicate dialog, queue advance, etc.). Cleared after consumption. */
    markResult?: MarkResult;
    /** Set by PageReviewScreen when submitTeacherScan raises a 409 so the
     *  MarkingScreen can surface its existing "Replace existing?" dialog. */
    markError?: { status?: number; error_code?: string; message?: string; extra?: Record<string, unknown> };
    /** The pages that were submitted (and failed) — stashed so a "Replace"
     *  re-navigation to PageReview can preload them and skip a re-shoot. */
    pendingPages?: CapturedPage[];
  } | undefined;
  PageReview: {
    initialPages: CapturedPage[];
    studentId: string;
    answerKeyId: string;
    educationLevel: EducationLevel;
    classId: string;
    className: string;
    replace?: boolean;
    /** Optional — passed through from MarkingScreen so the offline grading
     *  path has the full answer key and student name without a network
     *  fetch. Absent on legacy call sites; when absent, offline grading
     *  falls back to the queue-for-replay path with a friendly message. */
    answerKey?: AnswerKey;
    studentName?: string;
  };
  TeacherClassAnalytics: { class_id: string; class_name: string };
  TeacherStudentAnalytics: { student_id: string; student_name: string; class_id: string; class_name: string };
  HomeworkAnalytics: { homework_id: string; homework_title: string; class_id: string; class_name: string };
  EditProfile: undefined;
  TermsOfService: { initialTab?: 'terms' | 'privacy' } | undefined;
};

export type StudentTabParamList = {
  StudentHome: undefined;
  StudentSubmit: undefined;
  StudentResults: undefined;
  StudentTutor: undefined;
  StudentSettings: undefined;
};

export type StudentRootStackParamList = {
  StudentTabs: undefined;
  StudentCamera: { answer_key_id: string; answer_key_title: string; class_id: string };
  StudentPreview: { images: string[]; answer_key_id: string; answer_key_title: string; class_id: string };
  StudentConfirm: { images: string[]; answer_key_id: string; answer_key_title: string; class_id: string };
  SubmissionSuccess: { method: 'app' | 'whatsapp' | 'email' };
  Feedback: { mark_id: string; mark?: StudentMark };
  StudentAnalytics: { class_id: string };
  ClassManagement: undefined;
  SetPin: undefined;
};
