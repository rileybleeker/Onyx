import PageSkeleton from "@/components/PageSkeleton";

// Shown the moment the link is clicked while the server renders this force-dynamic page.
export default function Loading() {
  return <PageSkeleton title="Orders" width="max-w-2xl" tiles={0} blocks={["h-40"]} list={4} />;
}
