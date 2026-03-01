const { beforeUserCreated, beforeUserSignedIn, HttpsError } = require("firebase-functions/v2/identity");
const { initializeApp } = require("firebase-admin/app");
const fs = require("fs");
const path = require("path");

initializeApp();

const ALLOWLIST_CONFIG_CANDIDATES = [
  path.join(__dirname, "..", "config", "allowed_email_domains.json"),
  path.join(__dirname, "allowed_email_domains.json"),
];

function loadAllowlistConfig(configPath) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    throw new Error(`Could not read allowlist config at ${configPath}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Allowlist config at ${configPath} is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Allowlist config at ${configPath} must be a JSON object.`);
  }
  const domains = Array.isArray(parsed.domains) ? parsed.domains : [];
  const suffixes = Array.isArray(parsed.suffixes) ? parsed.suffixes : [];
  const normalizedDomains = new Set(
    domains.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean)
  );
  const normalizedSuffixes = suffixes
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  if (!normalizedDomains.size) {
    throw new Error(`Allowlist config at ${configPath} has an empty domains list.`);
  }
  if (!normalizedSuffixes.length) {
    throw new Error(`Allowlist config at ${configPath} has an empty suffixes list.`);
  }
  return { domains: normalizedDomains, suffixes: normalizedSuffixes };
}

let ALLOWLIST = null;
for (const configPath of ALLOWLIST_CONFIG_CANDIDATES) {
  if (!fs.existsSync(configPath)) continue;
  ALLOWLIST = loadAllowlistConfig(configPath);
  break;
}
if (!ALLOWLIST) {
  throw new Error(`No allowlist config found. Tried: ${ALLOWLIST_CONFIG_CANDIDATES.join(", ")}`);
}

function isEmailAllowed(email) {
  if (!email) return false;
  const lower = String(email).toLowerCase().trim();
  const atIndex = lower.lastIndexOf("@");
  if (atIndex < 0) return false;
  const domain = lower.slice(atIndex + 1);
  if (ALLOWLIST.domains.has(domain)) return true;
  return ALLOWLIST.suffixes.some((suffix) => domain.endsWith(suffix));
}

function enforceAllowlist(event) {
  const email = (event.data && event.data.email) ? event.data.email : "";
  if (!isEmailAllowed(email)) {
    throw new HttpsError(
      "permission-denied",
      "Please use your university email or a major email provider."
    );
  }
}

exports.beforecreated = beforeUserCreated((event) => {
  enforceAllowlist(event);
});

exports.beforesignedin = beforeUserSignedIn((event) => {
  enforceAllowlist(event);
});
