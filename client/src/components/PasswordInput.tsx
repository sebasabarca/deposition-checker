// A password field with a show/hide toggle, and the rules for a new password shown as they're met.
// The rules match the server's (server/src/auth.ts, passwordProblem).

import { useState, type InputHTMLAttributes } from "react";
import { Check, Eye, EyeOff } from "lucide-react";
import { cx, inputClass } from "./ui";

export const MIN_PASSWORD = 10;
export const PASSWORD_RULES: { label: string; met: (p: string) => boolean }[] = [
  { label: `At least ${MIN_PASSWORD} characters`, met: (p) => p.length >= MIN_PASSWORD },
  { label: "At least one special character, such as ! ? # or a space", met: (p) => /[^A-Za-z0-9]/.test(p) },
];
export const passwordOk = (p: string) => PASSWORD_RULES.every((r) => r.met(p));

export function PasswordInput({ className, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <input {...props} type={shown ? "text" : "password"} className={cx(inputClass, "pr-10", className)} />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? "Hide password" : "Show password"}
        aria-pressed={shown}
        title={shown ? "Hide password" : "Show password"}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-faint hover:text-ink"
      >
        {shown ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
      </button>
    </div>
  );
}

export function PasswordRules({ password, id }: { password: string; id?: string }) {
  return (
    <ul id={id} className="mt-2 space-y-1 text-xs">
      {PASSWORD_RULES.map((r) => {
        const met = r.met(password);
        return (
          <li key={r.label} className={cx("flex items-center gap-1.5", met ? "text-ok" : "text-faint")}>
            <span aria-hidden className={cx("flex size-3.5 flex-none items-center justify-center rounded-full", met ? "bg-ok text-white" : "ring-1 ring-inset ring-control")}>
              {met && <Check className="size-2.5" strokeWidth={3} />}
            </span>
            {r.label}
            <span className="sr-only">{met ? " (done)" : " (not yet)"}</span>
          </li>
        );
      })}
    </ul>
  );
}
