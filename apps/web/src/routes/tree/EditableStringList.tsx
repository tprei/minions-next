import type { ReactNode } from "react";
import { Button, TextInput } from "@minions/ui-kit";
import "./EditableStringList.css";

/**
 * Repeatable list of single-line text values (PR 46 — plan-tree-editor-approval) — used for a
 * working node's acceptance criteria and allowed repository paths, both of which the wire
 * schema requires as a non-empty `repeated string`. "Remove" is disabled on the last remaining
 * row so the list can never be emptied out from under that requirement.
 */
export interface EditableStringListProps {
  readonly label: string;
  readonly values: readonly string[];
  readonly onChange: (values: readonly string[]) => void;
  readonly placeholder?: string;
  readonly idPrefix: string;
  readonly disabled?: boolean;
}

export function EditableStringList({
  label,
  values,
  onChange,
  placeholder,
  idPrefix,
  disabled = false,
}: EditableStringListProps): ReactNode {
  return (
    <div className="mn-editable-list">
      <span className="mn-editable-list__label">{label}</span>
      {values.map((value, index) => (
        <div className="mn-editable-list__row" key={`${idPrefix}-${String(index)}`}>
          <TextInput
            aria-label={`${label} ${String(index + 1)}`}
            id={`${idPrefix}-${String(index)}`}
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(event) => {
              const next = [...values];
              next[index] = event.target.value;
              onChange(next);
            }}
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled || values.length <= 1}
            aria-label={`Remove ${label} ${String(index + 1)}`}
            onClick={() => {
              onChange(values.filter((_, candidateIndex) => candidateIndex !== index));
            }}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={disabled}
        onClick={() => {
          onChange([...values, ""]);
        }}
      >
        Add {label.toLowerCase()}
      </Button>
    </div>
  );
}
