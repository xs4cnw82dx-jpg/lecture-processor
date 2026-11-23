import globals from "globals";

// Reject page-local definitions of the shared helpers: a function declaration with
// the name, or a function assigned to a variable with the name (including
// `x = shared.fn || function () {...}` fallbacks).
function sharedHelperCopies(names) {
  const pattern = `/^(${names.join("|")})$/`;
  const message = "Use the shared helper (window.LectureProcessorHtml, LectureProcessorAuth or LectureProcessorUx) instead of a page copy.";
  return [
    { selector: `FunctionDeclaration[id.name=${pattern}]`, message },
    { selector: `VariableDeclarator[id.name=${pattern}] FunctionExpression`, message },
    { selector: `VariableDeclarator[id.name=${pattern}] ArrowFunctionExpression`, message },
  ];
}

export default [
  {
    ignores: [
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
      "static/js/**/*.min.js",
      "functions/**",
    ],
  },
  {
    files: ["static/js/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: {
        ...globals.browser,
        firebase: "readonly",
        flatpickr: "readonly",
        module: "readonly",
        Sentry: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-redeclare": "error",
      "no-unreachable": "error",
      "no-unused-vars": ["error", { vars: "all", args: "none", caughtErrors: "none" }],
      // Shared helpers live in one place; use them instead of writing page copies.
      "no-restricted-syntax": ["error", ...sharedHelperCopies(["escapeHtml"])],
    },
  },
  {
    // The shared definitions themselves, and the copies that must stay for now:
    // marked-lite.js loads before html-utils.js; markdown-utils.js and study-plan.js
    // keep tested fallbacks for when html-utils.js fails to load
    // (tests_js/markdown-utils.test.js, e2e/plan-html-fallback.spec.js);
    // index-app.js waits for its WP-E3 split.
    files: [
      "static/js/html-utils.js",
      "static/js/marked-lite.js",
      "static/js/markdown-utils.js",
      "static/js/study-plan.js",
      "static/js/index-app.js",
    ],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    files: ["scripts/**/*.mjs", "tests_js/**/*.js", "playwright.config.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      "no-undef": "error",
      "no-redeclare": "error",
      "no-unreachable": "error",
    },
  },
  {
    files: ["e2e/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "no-undef": "error",
      "no-redeclare": "error",
      "no-unreachable": "error",
    },
  },
];
