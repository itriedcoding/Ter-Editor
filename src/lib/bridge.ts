import type {
  AiModel,
  ChatMessage,
  DiagnosticItem,
  ExtCommand,
  ExtensionInfo,
  ExtensionTheme,
  ProjectSnapshot,
  Settings,
  TerApi,
} from '../../shared/ipc';

export const ter: TerApi = window.ter;

export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export type { AiModel, ChatMessage, DiagnosticItem, ExtCommand, ExtensionInfo, ExtensionTheme, ProjectSnapshot, Settings };

export const BUILTIN_COMMANDS = [
  { id: 'file.open-folder', title: 'File: Open Folder…' },
  { id: 'file.new-project', title: 'File: New Project…' },
  { id: 'file.new-file', title: 'File: New File' },
  { id: 'file.save', title: 'File: Save' },
  { id: 'file.close-editor', title: 'View: Close Editor' },
  { id: 'view.toggle-sidebar', title: 'View: Toggle Sidebar' },
  { id: 'view.toggle-chat', title: 'View: Toggle AI Chat' },
  { id: 'view.problems', title: 'View: Toggle Problems' },
  { id: 'view.output', title: 'View: Toggle Output' },
  { id: 'preferences.settings', title: 'Preferences: Open Settings' },
  { id: 'ai.new-chat', title: 'AI: New Chat' },
  { id: 'ai.explain-selection', title: 'AI: Explain Selection' },
] as const;
