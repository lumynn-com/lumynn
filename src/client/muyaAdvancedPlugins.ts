import type { IMuyaPluginConstructor } from "./vendor/muya/muya";
import { CodeBlockLanguageSelector } from "./vendor/muya/ui/codeBlockLanguageSelector";
import { EmojiSelector } from "./vendor/muya/ui/emojiSelector";
import { FootnoteTool } from "./vendor/muya/ui/footnoteTool";
import { ImageEditTool } from "./vendor/muya/ui/imageEditTool";
import { ImageResizeBar } from "./vendor/muya/ui/imageResizeBar";
import { ImageToolBar } from "./vendor/muya/ui/imageToolbar";
import { PreviewToolBar } from "./vendor/muya/ui/previewToolBar";
import { TableColumnToolbar } from "./vendor/muya/ui/tableColumnToolbar";
import { TableDragBar } from "./vendor/muya/ui/tableDragBar";
import { TableRowColumMenu } from "./vendor/muya/ui/tableRowColumMenu";

export const advancedMuyaPlugins = [
  EmojiSelector,
  FootnoteTool,
  ImageEditTool,
  ImageToolBar,
  ImageResizeBar,
  CodeBlockLanguageSelector,
  TableColumnToolbar,
  TableDragBar,
  TableRowColumMenu,
  PreviewToolBar
] as IMuyaPluginConstructor[];
