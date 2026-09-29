export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="text-primary">
      <g fill="currentColor">
        <circle cx="12" cy="6" r="4" opacity=".9" />
        <circle cx="17.7" cy="10.1" r="4" opacity=".75" />
        <circle cx="15.5" cy="16.8" r="4" opacity=".6" />
        <circle cx="8.5" cy="16.8" r="4" opacity=".75" />
        <circle cx="6.3" cy="10.1" r="4" opacity=".9" />
      </g>
      <circle cx="12" cy="12" r="2.6" fill="var(--card)" />
    </svg>
  );
}
