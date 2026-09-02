import type { ReactNode } from "react";

const fieldCls =
  "w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:bg-slate-50 disabled:text-slate-400";

export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-slate-700">
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

export function TextInput(props: {
  id: string;
  name?: string;
  type?: "text" | "email" | "password";
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
  minLength?: number;
  autoComplete?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  onChange?: (value: string) => void;
}) {
  return (
    <input
      id={props.id}
      name={props.name}
      type={props.type ?? "text"}
      className={fieldCls}
      value={props.value}
      defaultValue={props.defaultValue}
      placeholder={props.placeholder}
      required={props.required}
      minLength={props.minLength}
      autoComplete={props.autoComplete}
      autoFocus={props.autoFocus}
      disabled={props.disabled}
      onChange={props.onChange ? (e) => props.onChange?.(e.target.value) : undefined}
    />
  );
}
