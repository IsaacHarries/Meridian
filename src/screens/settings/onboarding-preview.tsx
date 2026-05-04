import { FlaskConical } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { usePreviewOnboarding } from "@/context/PreviewOnboardingContext";

export function OnboardingPreviewSection() {
  const previewOnboarding = usePreviewOnboarding();
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-muted-foreground" />
          Onboarding wizard preview
        </CardTitle>
        <CardDescription className="text-xs mt-0.5">
          Re-run the first-launch onboarding flow to iterate on its UI.
          Credentials aren't cleared — connecting an already-saved provider
          just refreshes the stored value. Closing the wizard returns you
          to Settings.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="outline" size="sm" onClick={previewOnboarding}>
          Show onboarding wizard
        </Button>
      </CardContent>
    </Card>
  );
}
