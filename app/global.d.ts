// Ambient module declarations for CSS imports used by the Expo web/NativeWind setup.
// Keeps `tsc --noEmit` clean; these imports are handled by the Metro/web CSS interop.
declare module '*.css';

declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}
