/** What follows the side panel in a layout without <main> (the full-screen /agents screens). */
export const AFTER_SIDE_PANEL = "[data-side-panel] ~ :not(script):not(style):not(template)";

/**
 * Where "Skip to page content" puts focus: the title of the page in view (`inView`, the side panel's current route:
 * the routed page or the continuous scroll's page Riley has scrolled to), else that page; with no match the opened
 * (routed) page's title, else that page, else <main>. The routed page is the continuous scroll's
 * `div[data-feed-route]`; the pages around it are <section>s whose title is `feed-page-heading`. /agents has no
 * <main> (AppShell draws it full screen): its title, else the screen that follows the side panel.
 */
export function pageContentTarget(doc: Pick<Document, "querySelector" | "querySelectorAll">, inView?: string | null): HTMLElement | null {
  if (inView) {
    for (const el of Array.from(doc.querySelectorAll<HTMLElement>("[data-feed-root] > [data-feed-route]"))) {
      if (el.getAttribute("data-feed-route") !== inView) continue;
      return el.querySelector<HTMLElement>('[data-testid="page-heading"], [data-testid="feed-page-heading"]') ?? el;
    }
  }
  const page = doc.querySelector<HTMLElement>("[data-feed-root] > div[data-feed-route]") ?? doc.querySelector<HTMLElement>("main");
  if (page) return page.querySelector<HTMLElement>('[data-testid="page-heading"]') ?? page;
  return doc.querySelector<HTMLElement>("h1") ?? doc.querySelector<HTMLElement>(AFTER_SIDE_PANEL);
}

/** The link's click: moves focus to the page in view, never the browser's own jump. Shared by every width. */
export function skipToPage(event: { preventDefault(): void }, inView: string | null) {
  // Never the browser's own jump: no element has the id, so it would only add #page-content to the address.
  event.preventDefault();
  const target = pageContentTarget(document, inView);
  if (!target) return;
  if (!target.hasAttribute("tabindex")) {
    target.setAttribute("tabindex", "-1");
    // Only while it holds the skip's focus: left in place, every click on the page's text would focus the page.
    target.addEventListener("blur", () => target.removeAttribute("tabindex"), { once: true });
  }
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "start" });
}
