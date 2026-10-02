// The checkpoint quiz and the mastery test both keep their records in localStorage as
// { version, courses }. Neither one trusts what comes back: a record written by an older release,
// by another tab or by hand must still leave the site usable, so reading starts here and each
// module then rebuilds its own state field by field.

const STORAGE_VERSION = 1;

// The saved courses, or null when the record is missing, unreadable or from another version.
function savedCourses(raw) {
  let saved;
  try {
    saved = JSON.parse(raw);
  } catch {
    return null; // blocked storage hands back null, an old release may hand back anything
  }
  if (saved?.version !== STORAGE_VERSION) return null;
  if (!saved.courses || typeof saved.courses !== 'object') return null;
  return saved.courses;
}

const forStorage = (progress) => JSON.stringify({ version: STORAGE_VERSION, courses: progress });

// Answers and attempts are plain data, so a copy is a round trip through JSON.
const copyOfRecord = (record) => JSON.parse(JSON.stringify(record));

export { savedCourses, forStorage, copyOfRecord };
