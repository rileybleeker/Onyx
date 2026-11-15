import { SectionSkeleton } from "./sections/ui";

// The Log screen before its code has loaded (server HTML of the static page, loading.tsx, the scroll): the real
// heading and the default section order with their skeletons, so the filled screen lands in the same place.
// Hook-free, no "use client": the server renders it too.
export default function LogSkeleton() {
  return (
    <div className="max-w-3xl">
      <div className="mb-5 flex min-h-11 items-end justify-between gap-3">
        <h1 className="text-[20px] font-medium text-text-primary tracking-tight">Log</h1>
      </div>
      <div className="space-y-6">
        <SectionSkeleton section="sayit" />
        <SectionSkeleton section="checkin" />
        <SectionSkeleton section="journal" />
        <SectionSkeleton section="supplements" />
      </div>
    </div>
  );
}
