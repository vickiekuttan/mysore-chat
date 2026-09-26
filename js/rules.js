// Shared rule helpers. The database enforces every rule; these only mirror
// them so the page can show a friendly counter before you hit Send.
(function () {
  // Must match public.count_words() in supabase/schema.sql.
  const SPACES = /[\s\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]+/g;

  function countWords(text) {
    const t = String(text || '').replace(SPACES, ' ').trim();
    return t === '' ? 0 : t.split(' ').length;
  }

  // Defaults; the live values come from the `settings` table.
  const DEFAULT_SETTINGS = {
    max_words_public: 8,
    max_chars_public: 160,
    max_words_friends: 200,
    max_chars_friends: 2000,
    spam_count: 10,
    spam_window_seconds: 60,
    spam_wait_seconds: 300,
    image_lock_seconds: 600,
    wipe_at_words: 1000000,
    total_words: 0
  };

  const ERRORS = {
    NOT_A_MEMBER: 'Your account is not set up yet. Try signing off and on again.',
    ROOM_NOT_FOUND: 'That room no longer exists.',
    NOT_IN_ROOM: 'Join this room before posting.',
    EMPTY: 'Type something first.',
    IMAGE_LOCKED: 'You sent an image recently. Wait for the cooldown to end.',
    SPAM_WAIT: 'Flood control: too many messages in a minute. Take a breather.',
    TOO_MANY_WORDS: 'Too many words for this room.',
    TOO_LONG: 'That message is too long.',
    NO_IMAGES_FOR_FRIENDS: 'Images are not allowed in friend chats.',
    BAD_IMAGE: 'That image did not upload properly. Try again.',
    GROUP_NAME_INVALID: 'Use 2 to 24 lowercase letters, numbers or _.',
    GROUP_NAME_TAKEN: 'A group with that name already exists.',
    TOO_MANY_GROUPS: 'Group limit reached.',
    TOO_MANY_INVITES: 'You already have 5 unused invite codes. Use those first.',
    INVITE_INVALID: 'That invite code does not work. It may already be used.',
    USERNAME_INVALID: 'Screen names are 3 to 20 letters, numbers or _.',
    USERNAME_TAKEN: 'That screen name is taken.',
    REQUEST_NOT_FOUND: 'That friend request is no longer open.',
    NOT_YOURSELF: 'You cannot do that to yourself.',
    USER_NOT_FOUND: 'That person no longer exists.',
    BANNED: 'You have been banned from Pazhampori chat.',
    USER_BANNED: 'That person is banned.',
    NOT_ADMIN: 'Only admins can do that.',
    CANNOT_CHANGE_OWNER: 'The founder cannot be demoted or banned.',
    DEMOTE_FIRST: 'Make them a regular first, then ban them.'
  };

  function errorCode(err) {
    const msg = (err && (err.code && ERRORS[err.code] ? err.code : err.message)) || '';
    const m = String(msg).match(/[A-Z][A-Z_]{3,}/g) || [];
    return m.find((c) => ERRORS[c]) || null;
  }

  function friendlyError(err) {
    const code = errorCode(err);
    if (code) return ERRORS[code];
    const msg = String((err && err.message) || err || '');
    if (/failed to fetch|network/i.test(msg)) return 'No carrier. Check your connection and try again.';
    if (/payload too large|exceeded|size/i.test(msg)) return 'That image is too big (5 MB max).';
    return msg || 'Something went wrong. Try again.';
  }

  window.PZ = window.PZ || {};
  Object.assign(window.PZ, { countWords, DEFAULT_SETTINGS, ERRORS, errorCode, friendlyError });
})();
