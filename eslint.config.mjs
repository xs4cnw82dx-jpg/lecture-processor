import globals from "globals";

// Shared helpers live in one place (html-utils.js, auth-utils.js, ux-utils.js);
// pages use them instead of keeping their own copies.
const SHARED_HELPERS = ["escapeHtml", "authFetch"];

// Files allowed to define a helper, and why.
const HELPER_EXEMPTIONS = {
  // The shared definitions.
  "static/js/html-utils.js": ["escapeHtml"],
  "static/js/auth-utils.js": ["authFetch"],
  // Loads before html-utils.js on the lecture page.
  "static/js/marked-lite.js": ["escapeHtml"],
  // Tested fallbacks for when html-utils.js fails to load
  // (tests_js/markdown-utils.test.js, e2e/plan-html-fallback.spec.js).
  "static/js/markdown-utils.js": ["escapeHtml"],
  "static/js/study-plan.js": ["escapeHtml"],
  // The app shell's request helper also undoes a session login when the account
  // changes mid-request, which the shared client does not do.
  "static/js/app-shell.js": ["authFetch"],
  // Waits for its WP-E3 split to settle.
  "static/js/index-app.js": ["escapeHtml", "authFetch"],
};

// Reject page-local definitions of the shared helpers: a function declaration with
// the name, or a function assigned to a variable with the name (including
// `x = shared.fn || function () {...}` fallbacks).
function sharedHelperRule(names) {
  if (!names.length) return "off";
  const pattern = `/^(${names.join("|")})$/`;
  const message = "Use the shared helper (window.LectureProcessorHtml, LectureProcessorAuth or LectureProcessorUx) instead of a page copy.";
  return ["error",
    { selector: `FunctionDeclaration[id.name=${pattern}]`, message },
    { selector: `VariableDeclarator[id.name=${pattern}] FunctionExpression`, message },
    { selector: `VariableDeclarator[id.name=${pattern}] ArrowFunctionExpression`, message },
  ];
}

const helperExemptionConfigs = Object.entries(HELPER_EXEMPTIONS).map(([file, allowed]) => ({
  files: [file],
  rules: { "no-restricted-syntax": sharedHelperRule(SHARED_HELPERS.filter(name => !allowed.includes(name))) },
}));

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
      "no-restricted-syntax": sharedHelperRule(SHARED_HELPERS),
    },
  },
  ...helperExemptionConfigs,
  {
    files: ["static/js/book-studio.js", "static/js/book-studio-*.js"],
    languageOptions: { sourceType: "module" },
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
