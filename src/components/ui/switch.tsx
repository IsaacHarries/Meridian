import * as React from "react";

export interface SwitchProps extends React.InputHTMLAttributes<HTMLInputElement> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

export const Switch: React.FC<SwitchProps> = ({ checked, onCheckedChange, ...props }) => (
  <label style={{ display: "inline-flex", alignItems: "center", cursor: "pointer" }}>
    <input
      type="checkbox"
      checked={checked}
      onChange={e => onCheckedChange(e.target.checked)}
      style={{ display: "none" }}
      {...props}
    />
    <span
      style={{
        width: 32,
        height: 18,
        background: checked ? "#4f46e5" : "#d1d5db",
        borderRadius: 9999,
        position: "relative",
        transition: "background 0.2s",
        display: "inline-block"
      }}
    >
      <span
        style={{
          position: "absolute",
          left: checked ? 16 : 2,
          top: 2,
          width: 14,
          height: 14,
          background: "#fff",
          borderRadius: "50%",
          boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
          transition: "left 0.2s"
        }}
      />
    </span>
  </label>
);

