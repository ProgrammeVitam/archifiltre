import { Menubar as MenubarPrimitive } from 'bits-ui';
import Root from './menubar.svelte';
import Trigger from './menubar-trigger.svelte';
import Content from './menubar-content.svelte';
import Item from './menubar-item.svelte';
import Separator from './menubar-separator.svelte';
import Shortcut from './menubar-shortcut.svelte';

const Menu = MenubarPrimitive.Menu;
const Group = MenubarPrimitive.Group;

export {
	Root,
	Menu,
	Trigger,
	Content,
	Item,
	Separator,
	Shortcut,
	Group,
	//
	Root as Menubar,
	Menu as MenubarMenu,
	Trigger as MenubarTrigger,
	Content as MenubarContent,
	Item as MenubarItem,
	Separator as MenubarSeparator,
	Shortcut as MenubarShortcut
};
