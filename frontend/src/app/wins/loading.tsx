export default function Loading() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <p className="text-sm text-text-secondary" role="status">Checking the latest progress...</p>
      <div aria-hidden="true" className="space-y-6">
        <div className="skeleton h-10 w-2/3 max-w-sm" />
        <div className="grid grid-cols-3 gap-2 sm:gap-4">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-24" />)}</div>
        <div className="grid gap-4 xl:grid-cols-[220px_minmax(0,1fr)] xl:gap-6">
          <div className="skeleton h-20" />
          <div className="space-y-4"><div className="skeleton h-64" /><div className="skeleton h-64" /></div>
        </div>
      </div>
    </div>
  );
}
