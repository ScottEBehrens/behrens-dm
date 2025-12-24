// lambdas/circles-auth-handler.js
// Node.js 20 compatible
// Purpose: Cognito Hosted UI auth with PKCE + HttpOnly refresh cookie
//
// Endpoints:
//  - GET  /auth/login
//  - GET  /auth/callback
//  - POST /auth/token
//  - GET  /auth/me
//  - POST /auth/logout

const crypto = require("crypto");
const https = require("https");
const querystring = require("querystring");

// -------------------------
// Env vars (set in CDK)
// -------------------------
const {
  COGNITO_DOMAIN,       // e.g. https://your-domain.auth.us-east-1.amazoncognito.com
  COGNITO_CLIENT_ID,    // User Pool App Client ID
  COGNITO_REDIRECT_URI, // e.g. https://circles.behrens-hub.com/auth/callback
  FRONTEND_BASE_URL,    // e.g. https://circles.behrens-hub.com
  COOKIE_DOMAIN,        // optional; often omit for host-only cookie
  COOKIE_SAMESITE,      // optional; default "Lax"
} = process.env;

if (!COGNITO_DOMAIN || !COGNITO_CLIENT_ID || !COGNITO_REDIRECT_URI) {
  throw new Error(
    "Missing required env vars: COGNITO_DOMAIN, COGNITO_CLIENT_ID, COGNITO_REDIRECT_URI"
  );
}

const SAME_SITE = COOKIE_SAMESITE || "Lax"; // Lax recommended for same-site OAuth redirects

// -------------------------
// Helpers
// -------------------------
function base64UrlEncode(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function sha256(str) {
  return crypto.createHash("sha256").update(str).digest();
}

function randomString(bytes = 32) {
  return base64UrlEncode(crypto.randomBytes(bytes));
}

function parseCookies(headerValue) {
  const out = {};
  if (!headerValue || typeof headerValue !== "string") return out;

  // Split on ; but tolerate weird spacing
  const parts = headerValue.split(";");
  for (const part of parts) {
    const p = part.trim();
    if (!p) continue;
    const idx = p.indexOf("=");
    if (idx <= 0) continue;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function buildCookie(name, value, options = {}) {
  const parts = [`${name}=${value}`];

  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  parts.push(`Path=${options.path || "/"}`);

  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);

  // Usually omit Domain to keep host-only cookies (safer).
  if (COOKIE_DOMAIN) parts.push(`Domain=${COOKIE_DOMAIN}`);

  return parts.join("; ");
}

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

function redirect(location, cookies = []) {
  const resp = {
    statusCode: 302,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
    },
    body: "",
  };

  if (cookies.length) {
    resp.multiValueHeaders = { "Set-Cookie": cookies };
  }

  return resp;
}

function unauthorized(message = "Unauthorized") {
  return json(401, { message });
}

function badRequest(message) {
  return json(400, { message });
}

function notFound() {
  return json(404, { message: "Not found" });
}

// -------------------------
// Cognito token exchange
// -------------------------
function postForm(urlString, bodyObj) {
  const postData = querystring.stringify(bodyObj);
  const url = new URL(urlString);

  const options = {
    hostname: url.hostname,
    path: url.pathname,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(postData),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        // Cognito sometimes returns JSON error bodies
        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch {
          // leave parsed null
        }
        resolve({
          statusCode: res.statusCode || 0,
          raw: data,
          body: parsed,
        });
      });
    });

    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

async function exchangeAuthCodeForTokens({ code, codeVerifier }) {
  return postForm(`${COGNITO_DOMAIN}/oauth2/token`, {
    grant_type: "authorization_code",
    client_id: COGNITO_CLIENT_ID,
    code,
    redirect_uri: COGNITO_REDIRECT_URI,
    code_verifier: codeVerifier,
  });
}

async function exchangeRefreshForTokens({ refreshToken }) {
  return postForm(`${COGNITO_DOMAIN}/oauth2/token`, {
    grant_type: "refresh_token",
    client_id: COGNITO_CLIENT_ID,
    refresh_token: refreshToken,
  });
}

// -------------------------
// JWT helpers (display-only)
// -------------------------
function decodeJwtNoVerify(jwt) {
  const parts = String(jwt || "").split(".");
  if (parts.length !== 3) return null;

  const payload = parts[1];
  // base64url -> base64
  const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  const b64 = padded + "=".repeat(padLen);

  try {
    const jsonStr = Buffer.from(b64, "base64").toString("utf8");
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

function chooseDisplayName(claims) {
  if (!claims) return "Signed in";
  return (
    claims.name ||
    claims.email ||
    claims["cognito:username"] ||
    claims.username ||
    claims.sub ||
    "Signed in"
  );
}

function extractBearerToken(headers) {
  const h =
    headers?.authorization ||
    headers?.Authorization ||
    headers?.AUTHORIZATION ||
    "";
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// -------------------------
// Handler
// -------------------------
exports.handler = async (event) => {
  const method = event.httpMethod || "GET";
  const path = event.path || "/";

  // We’re same-origin behind CloudFront, so we can keep CORS minimal.
  // If you ever call /auth/* cross-origin, we can tighten/expand later.
  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Cache-Control": "no-store",
      },
      body: "",
    };
  }

  // --- GET /auth/login ---
  if (method === "GET" && path === "/auth/login") {
    const state = randomString(16);
    const codeVerifier = randomString(32);
    const codeChallenge = base64UrlEncode(sha256(codeVerifier));

    // Temp cookies for callback validation (short-lived)
    const cookies = [
      buildCookie("oauth_state", state, {
        httpOnly: true,
        secure: true,
        sameSite: SAME_SITE,
        path: "/auth",
        maxAge: 300, // 5 minutes
      }),
      buildCookie("pkce_verifier", codeVerifier, {
        httpOnly: true,
        secure: true,
        sameSite: SAME_SITE,
        path: "/auth",
        maxAge: 300,
      }),
    ];

    const authUrl =
      `${COGNITO_DOMAIN}/oauth2/authorize?` +
      querystring.stringify({
        response_type: "code",
        client_id: COGNITO_CLIENT_ID,
        redirect_uri: COGNITO_REDIRECT_URI,
        scope: "openid email profile",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });

    return redirect(authUrl, cookies);
  }

  // --- GET /auth/callback ---
  if (method === "GET" && path === "/auth/callback") {
    const qs = event.queryStringParameters || {};
    const { code, state } = qs;

    if (!code || !state) return badRequest("Missing code or state");

    const cookieHeader = event.headers?.cookie || event.headers?.Cookie || "";
    const cookieMap = parseCookies(cookieHeader);

    if (!cookieMap.oauth_state || cookieMap.oauth_state !== state) {
      return badRequest("Invalid OAuth state");
    }

    if (!cookieMap.pkce_verifier) {
      return badRequest("Missing PKCE verifier");
    }

    const tokenResponse = await exchangeAuthCodeForTokens({
      code,
      codeVerifier: cookieMap.pkce_verifier,
    });

    if (tokenResponse.statusCode !== 200 || !tokenResponse.body) {
      return badRequest(
        `Token exchange failed (${tokenResponse.statusCode})`
      );
    }

    const { refresh_token } = tokenResponse.body;

    if (!refresh_token) {
      return badRequest("No refresh token returned (check Cognito app client flow)");
    }

    // Refresh token cookie: HttpOnly, Secure, SameSite=Lax, scoped to /auth
    // Max-Age here is a browser hint; true lifetime is enforced by Cognito app client config.
    const cookiesOut = [
      buildCookie("refresh_token", refresh_token, {
        httpOnly: true,
        secure: true,
        sameSite: SAME_SITE,
        path: "/auth",
        maxAge: 60 * 60 * 24 * 30, // 30 days
      }),

      // Clear temp cookies
      buildCookie("oauth_state", "", {
        path: "/auth",
        maxAge: 0,
        httpOnly: true,
        secure: true,
        sameSite: SAME_SITE,
        ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
      }),
      buildCookie("pkce_verifier", "", {
        path: "/auth",
        maxAge: 0,
        httpOnly: true,
        secure: true,
        sameSite: SAME_SITE,
        ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
      }),

    ];

    return redirect(FRONTEND_BASE_URL || "/", cookiesOut);
  }

  // --- POST /auth/token ---
  // Uses refresh_token cookie to mint a new access token (no ID token returned).
  if (method === "POST" && path === "/auth/token") {
    const cookieHeader = event.headers?.cookie || event.headers?.Cookie || "";
    const cookieMap = parseCookies(cookieHeader);

    const refreshToken = cookieMap.refresh_token;
    if (!refreshToken) return unauthorized("Missing refresh token cookie");

    const tokenResponse = await exchangeRefreshForTokens({ refreshToken });

    if (tokenResponse.statusCode !== 200 || !tokenResponse.body) {
      // If refresh token expired/revoked, tell client to re-login.
      return unauthorized("Refresh failed; please sign in again");
    }

    const { access_token, id_token, expires_in, token_type } = tokenResponse.body;

    if (!access_token) {
      return unauthorized("No access token returned");
    }

    return json(200, {
      access_token,
      id_token,
      expires_in: expires_in || 3600,
      token_type: token_type || "Bearer",
    });
  }

  // --- GET /auth/me ---
  // Display-only: reads access token from Authorization header and returns claims + displayName.
  if (method === "GET" && path === "/auth/me") {
    const token = extractBearerToken(event.headers || {});
    if (!token) return unauthorized("Missing Authorization bearer token");

    const claims = decodeJwtNoVerify(token);
    if (!claims) return unauthorized("Invalid token");

    // Basic sanity checks (still display-only; not a substitute for API auth)
    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof claims.exp === "number" && claims.exp <= nowSec) {
      return unauthorized("Token expired");
    }
    if (claims.token_use && !["access", "id"].includes(claims.token_use)) {
      return unauthorized("Wrong token type");
    }

    const displayName = chooseDisplayName(claims);

    // Return the fields your UI cares about (and a few helpful ones).
    // You can slim this down later if you want.
    return json(200, {
      displayName,
      claims: {
        sub: claims.sub,
        name: claims.name,
        email: claims.email,
        "cognito:username": claims["cognito:username"],
        username: claims.username,
      },
    });
  }

  // --- POST /auth/logout ---
  // Clears refresh cookie. (Optional future: revoke refresh token.)
  if (method === "POST" && path === "/auth/logout") {
    const cookiesOut = [
      buildCookie("refresh_token", "", {
        httpOnly: true,
        secure: true,
        sameSite: SAME_SITE,
        path: "/auth",
        maxAge: 0,
      }),
    ];

    return {
      statusCode: 204,
      headers: {
        "Cache-Control": "no-store",
      },
      multiValueHeaders: {
        "Set-Cookie": cookiesOut,
      },
      body: "",
    };

  }

  return notFound();
};
