import Link from "next/link";
import { Shell } from "@/components/shell";

export default function NotFound() {
  return (
    <Shell>
      <h1 className="text-3xl font-semibold">Not found</h1>
      <p className="mt-2 text-sm text-muted">No public aggregate for that path. Raw history is not hosted here.</p>
      <Link href="/" className="mt-4 inline-block text-accent hover:underline">
        Back to leaderboards
      </Link>
    </Shell>
  );
}
