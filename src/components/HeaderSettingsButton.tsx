import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOpenSettings } from "@/context/OpenSettingsContext";

export function HeaderSettingsButton({ className }: { className?: string }) {
  const open = useOpenSettings();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={className}
      onClick={open}
      aria-label="Open settings"
    >
      <Settings className="h-4 w-4" />
    </Button>
  );
}
