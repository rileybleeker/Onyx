import PageSkeleton from "@/components/PageSkeleton";

// Shown the moment the link is clicked while the server renders this force-dynamic page.
export default function Loading() {
  return <PageSkeleton title="Screen Time" tiles={4} blocks={["h-72", "h-56"]} />;
}
