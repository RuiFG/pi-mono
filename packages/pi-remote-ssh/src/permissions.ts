import { stripVTControlCharacters } from "node:util";

/** Confirmation is only used by host-management and credential-storage dialogs. */
export type Confirm = (title: string, message: string, signal?: AbortSignal) => Promise<boolean>;
export function display(value: string): string {
  return stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}
