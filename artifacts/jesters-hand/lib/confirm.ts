// Cross-platform alert/confirm. React Native Web silently no-ops Alert.alert,
// which made buttons that rely on confirmation dialogs appear "dead" on web.
import { Alert, Platform } from 'react-native';

export function showAlert(title: string, message?: string) {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    window.alert(message ? `${title}\n\n${message}` : title);
  } else {
    Alert.alert(title, message);
  }
}

export function confirmAction(
  title: string,
  message: string,
  confirmLabel: string,
  onConfirm: () => void,
  destructive = true,
) {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (window.confirm(`${title}\n\n${message}`)) onConfirm();
  } else {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: confirmLabel, style: destructive ? 'destructive' : 'default', onPress: onConfirm },
    ]);
  }
}
