import PageSkeleton from "@/components/PageSkeleton";

// Shown the moment the link is clicked while the server renders this force-dynamic page.
export default function Loading() {
  return <PageSkeleton title="Budgets" tiles={3} blocks={["h-48"]} list={6} />;
}
