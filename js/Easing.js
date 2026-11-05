// How a movement speeds up and slows down between its two ends: t (0…1,
// time) -> how far along (0…1). In the order the ease buttons cycle.
export const EASINGS = [
  { id: 'easeInOut', label: 'Плавно' },
  { id: 'linear', label: 'Ровно' },
  { id: 'easeIn', label: 'Разгон' },
  { id: 'easeOut', label: 'Тормоз' },
];

export const EASING_FNS = {
  linear: t => t,
  easeInOut: t => t * t * (3 - 2 * t),
  easeIn: t => t * t,
  easeOut: t => t * (2 - t),
};
