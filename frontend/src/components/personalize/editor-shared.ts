/** Personalize editor internals shared by its files (one chunk): screen-reader announcements. */

let say: (text: string) => void = () => {};

/** The banner owns the live region and installs the speaker while it is open. */
export function setSpeaker(fn: ((text: string) => void) | null) {
  say = fn ?? (() => {});
}

export function announce(text: string) {
  say(text);
}
