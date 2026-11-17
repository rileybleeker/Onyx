// Plain sentences for the stored sync error codes of the Google Calendar care sync
// (care-google.ts). Any other value returns null, so a raw message or code is never shown.
export function syncErrorSentence(error: string | null | undefined): string | null {
  if (error === 'google_auth') return "Google no longer accepts Onyx's access. Disconnect, then connect again.";
  if (error === 'calendar_missing') return 'The calendar Onyx created is gone from Google. Disconnect, then connect again to make a new one.';
  return null;
}
