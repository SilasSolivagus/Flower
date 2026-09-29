import type { ApiError } from '@/lib/api';

export function FormError({ error }: { error: ApiError | null | undefined }) {
  if (!error) return null;
  const details = Array.isArray(error.details) ? (error.details as Array<{ path?: string; message?: string }>) : [];
  return (
    <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
      <p>{error.message}</p>
      {details.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {details.map((d, i) => (
            <li key={i}>{d.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
