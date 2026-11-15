import PageSkeleton from "@/components/PageSkeleton";

// Shown the moment the link is clicked while the server renders this force-dynamic page.
export default function Loading() {
  return <PageSkeleton title="Reading" width="max-w-3xl" tiles={3} blocks={["h-56"]} list={3} />;
}
