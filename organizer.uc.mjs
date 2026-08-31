const MENU_ID = "zen-organizer-menu-item";
const { openOrganizer } = ChromeUtils.importESModule(
  "chrome://zenorganizer/content/zen-adapter.mjs",
);

const toolsMenu = document.getElementById("menu_ToolsPopup");
if (toolsMenu && !document.getElementById(MENU_ID)) {
  const item = document.createXULElement("menuitem");
  item.id = MENU_ID;
  item.setAttribute("label", "Zen Organizer");
  item.setAttribute("accesskey", "O");
  item.addEventListener("command", () => openOrganizer(window));
  toolsMenu.appendChild(item);
  window.addUnloadListener?.(() => item.remove());
}
