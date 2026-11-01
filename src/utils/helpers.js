// Small shared helpers: money rounding, error handling, date ranges.

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Wrap async route handlers so thrown errors reach the error middleware
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const escapeRegex = (s = '') => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Dates use the server's local timezone (set TZ=Asia/Kolkata in .env)
export const startOfDay = (d = new Date()) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
export const endOfDay = (d = new Date()) => {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
};
// Week starts on Monday
export const startOfWeek = (d = new Date()) => {
  const x = startOfDay(d);
  const diff = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - diff);
  return x;
};
export const startOfMonth = (d = new Date()) => {
  const x = startOfDay(d);
  x.setDate(1);
  return x;
};

// Parse "YYYY-MM-DD" as a local date
export const parseDay = (s) => {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
};

// Build a Mongo date filter from ?from=YYYY-MM-DD&to=YYYY-MM-DD
export const dateRange = (from, to) => {
  const f = parseDay(from);
  const t = parseDay(to);
  if (!f && !t) return null;
  const q = {};
  if (f) q.$gte = startOfDay(f);
  if (t) q.$lte = endOfDay(t);
  return q;
};

// Sale date chosen in the form ("YYYY-MM-DD"): keep the current time when it is today
export const resolveEntryDate = (s) => {
  const d = parseDay(s);
  if (!d) return new Date();
  const now = new Date();
  if (startOfDay(now).getTime() === d.getTime()) return now;
  d.setHours(12, 0, 0, 0);
  return d;
};
