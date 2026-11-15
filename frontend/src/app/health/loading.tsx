import PageSkeleton from "@/components/PageSkeleton";

// Shown the moment the link is clicked while the server renders this force-dynamic page.
export default function Loading() {
  return <PageSkeleton title="Health & appointments" width="max-w-4xl" tiles={0} blocks={["h-40", "h-80"]} />;
}
