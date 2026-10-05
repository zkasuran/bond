import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

/**
 * Bottom padding that keeps a composer above the on-screen keyboard on Android.
 *
 * With edge-to-edge (the default on modern Android) the window no longer resizes for
 * the keyboard, and KeyboardAvoidingView under-measures the overlap, which left the
 * send button behind the keyboard. This reads the keyboard height from the keyboard
 * events instead. On edge-to-edge Android the reported height excludes the navigation
 * bar, which the screen's bottom safe-area padding already covers, so the keyboard
 * height itself is exactly the extra padding needed.
 * iOS keeps using KeyboardAvoidingView, so this returns 0 there and on web.
 */
export function useAndroidKeyboardInset(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const show = Keyboard.addListener("keyboardDidShow", (e) => setHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener("keyboardDidHide", () => setHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return Platform.OS === "android" ? height : 0;
}
