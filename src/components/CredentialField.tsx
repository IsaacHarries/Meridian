import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const MASKED_SENTINEL = "••••••••";

interface CredentialFieldProps {
  id: string;
  label: string;
  placeholder?: string;
  helperText?: string;
  masked?: boolean;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

export function CredentialField({
  id,
  label,
  placeholder,
  helperText,
  masked = false,
  value,
  onChange,
  disabled,
  className,
}: CredentialFieldProps) {
  const [revealed, setRevealed] = useState(false);

  const isSentinel = value === MASKED_SENTINEL;

  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type={masked && !revealed ? "password" : "text"}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={masked ? "pr-9" : undefined}
          autoComplete={masked ? "new-password" : "off"}
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
        />
        {masked && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-0 top-0 h-9 w-9 text-muted-foreground hover:text-foreground"
            onClick={() => !isSentinel && setRevealed((r) => !r)}
            tabIndex={-1}
            disabled={disabled || isSentinel}
            title={isSentinel ? "Value is stored securely and cannot be displayed — clear the field to enter a new one" : undefined}
          >
            {revealed && !isSentinel ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        )}
      </div>
      {helperText && <p className="text-xs text-muted-foreground">{helperText}</p>}
    </div>
  );
}
