import type {Layer} from '@asmr-studio/contracts';
import IconBook from '@tabler/icons-react/icons/IconBook';
import IconBox from '@tabler/icons-react/icons/IconBox';
import IconBrush from '@tabler/icons-react/icons/IconBrush';
import IconBug from '@tabler/icons-react/icons/IconBug';
import IconCloudRain from '@tabler/icons-react/icons/IconCloudRain';
import IconDroplets from '@tabler/icons-react/icons/IconDroplets';
import IconFeather from '@tabler/icons-react/icons/IconFeather';
import IconFlame from '@tabler/icons-react/icons/IconFlame';
import IconGlass from '@tabler/icons-react/icons/IconGlass';
import IconHandMove from '@tabler/icons-react/icons/IconHandMove';
import IconHeadphones from '@tabler/icons-react/icons/IconHeadphones';
import IconKeyboard from '@tabler/icons-react/icons/IconKeyboard';
import IconMicrophone from '@tabler/icons-react/icons/IconMicrophone';
import IconRipple from '@tabler/icons-react/icons/IconRipple';
import IconShirt from '@tabler/icons-react/icons/IconShirt';
import IconWind from '@tabler/icons-react/icons/IconWind';
import type {Icon} from '@tabler/icons-react';

// Display-only hints for the starter collection. Imports retain a role-based fallback.
const recordings: Record<string, Icon> = {
  'Rain': IconCloudRain,
  'Fireplace': IconFlame,
  'Wind': IconWind,
  'Ocean waves': IconRipple,
  'Forest birds': IconFeather,
  'Woodland stream': IconDroplets,
  'Night crickets': IconBug,
  'Mic foam brushing': IconBrush,
  'Cardboard tapping': IconBox,
  'Fingernail glass taps': IconGlass,
  'Turning book pages': IconBook,
  'Keyboard typing': IconKeyboard,
  'Windscreen rubbing': IconMicrophone,
  'Makeup brush on skin': IconBrush,
  'Slow fabric petting': IconShirt,
  'Slow hand rubbing': IconHandMove,
};
const roles: Record<Layer['role'], Icon> = {
  ambience: IconHeadphones, texture: IconHandMove, narration: IconMicrophone,
};

export function SoundIcon({name, role, size = 28}: {name: string; role: Layer['role']; size?: number}) {
  const IconComponent = Object.hasOwn(recordings, name) ? recordings[name]! : roles[role];
  return <IconComponent size={size} stroke={1.6} aria-hidden="true" focusable="false"/>;
}
