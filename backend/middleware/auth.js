const jwt = require("jsonwebtoken");

const SESSION_COOKIE = "balancevault_session";

function getSessionToken(req) {
  const authorization = req.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length);
  }

  const cookieHeader = req.get("cookie");
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name === SESSION_COOKIE) {
      try {
        return decodeURIComponent(valueParts.join("="));
      } catch {
        return null;
      }
    }
  }

  return null;
}

function createAuthMiddleware({ prisma, jwtSecret }) {
  const authenticate = async (req, res, next) => {
    const token = getSessionToken(req);
    if (!token || !jwtSecret) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    let payload;
    try {
      payload = jwt.verify(token, jwtSecret, { algorithms: ["HS256"] });
    } catch (error) {
      if (
        error instanceof jwt.JsonWebTokenError ||
        error instanceof jwt.TokenExpiredError ||
        error instanceof jwt.NotBeforeError
      ) {
        return res.status(401).json({ success: false, message: "Session is invalid or expired" });
      }
      return next(error);
    }

    if (typeof payload !== "object" || typeof payload.sub !== "string") {
      return res.status(401).json({ success: false, message: "Session is invalid or expired" });
    }

    try {
      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, name: true, email: true, role: true, isActive: true },
      });

      if (!user || !user.isActive) {
        return res.status(401).json({ success: false, message: "Account is unavailable" });
      }

      req.user = user;
      return next();
    } catch (error) {
      return next(error);
    }
  };

  const requireRole = (...roles) => (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: "You do not have permission to do that" });
    }
    return next();
  };

  return { authenticate, requireRole };
}

function sessionCookieOptions() {
  const secure = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure,
    sameSite: secure ? "none" : "lax",
    path: "/api",
    maxAge: 60 * 60 * 1000,
  };
}

function sessionCookieAttributes(value, maxAge) {
  const options = sessionCookieOptions();
  const attributes = [
    `${SESSION_COOKIE}=${value}`,
    options.httpOnly ? "HttpOnly" : null,
    `SameSite=${options.sameSite}`,
    `Path=${options.path}`,
    `Max-Age=${Math.floor(maxAge / 1000)}`,
  ];
  if (options.secure) attributes.push("Secure");
  return attributes.filter(Boolean).join("; ");
}

function setSessionCookie(res, token) {
  const options = sessionCookieOptions();
  res.setHeader(
    "Set-Cookie",
    sessionCookieAttributes(encodeURIComponent(token), options.maxAge),
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", sessionCookieAttributes("", 0));
}

module.exports = {
  SESSION_COOKIE,
  createAuthMiddleware,
  setSessionCookie,
  clearSessionCookie,
};
