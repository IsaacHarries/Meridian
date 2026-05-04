import { Button } from "@/components/ui/button";
import { type BitbucketPr } from "@/lib/tauri/bitbucket";
import { Check } from "lucide-react";

export function DoneStep({
  selectedPr,
  onAddressAnother,
  onBack,
}: {
  selectedPr: BitbucketPr | null;
  onAddressAnother: () => void;
  onBack: () => void;
}) {
  return (
    <div className="rounded-xl border bg-card/60 p-8 flex flex-col items-center gap-4 text-center">
      <div className="rounded-full bg-green-500/15 p-4">
        <Check className="h-8 w-8 text-green-500" />
      </div>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Done!</h2>
        <p className="text-sm text-muted-foreground">
          Your fixes have been committed and pushed to{" "}
          <code className="font-mono">{selectedPr?.sourceBranch}</code>.
        </p>
      </div>
      <div className="flex gap-2">
        <Button onClick={onAddressAnother}>
          Address Another PR
        </Button>
        <Button variant="ghost" onClick={onBack}>
          Back to Home
        </Button>
      </div>
    </div>
  );
}
