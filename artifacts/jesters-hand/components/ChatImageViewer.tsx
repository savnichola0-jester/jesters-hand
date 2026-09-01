import React from 'react';
import {
  Image,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@/components/FIcon';
import { useAppDimensions } from '@/lib/appWindow';

interface ChatImageViewerProps {
  uri: string | null;
  onClose: () => void;
}

export default function ChatImageViewer({ uri, onClose }: ChatImageViewerProps) {
  const insets = useSafeAreaInsets();
  const { width, height } = useAppDimensions();

  return (
    <Modal
      visible={!!uri}
      animationType="fade"
      transparent
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={s.backdrop}>
        <View style={[s.shell, { width, height }]}>
          {uri ? (
            <ScrollView
              style={s.scroller}
              contentContainerStyle={s.imageWrap}
              minimumZoomScale={1}
              maximumZoomScale={4}
              centerContent
              showsHorizontalScrollIndicator={false}
              showsVerticalScrollIndicator={false}
            >
              <Image
                source={{ uri }}
                style={{ width, height }}
                resizeMode="contain"
                {...(Platform.OS === 'web' ? { draggable: false } as any : {})}
              />
            </ScrollView>
          ) : null}

          <TouchableOpacity
            style={[s.closeButton, { top: Math.max(insets.top, Platform.OS === 'web' ? 50 : 12) + 8 }]}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close full image"
            activeOpacity={0.75}
          >
            <Feather name="x" size={25} color="#EDE0C4" />
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.96)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shell: {
    maxWidth: 430,
    maxHeight: '100%',
    backgroundColor: '#050403',
    overflow: 'hidden',
  },
  scroller: {
    flex: 1,
  },
  imageWrap: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeButton: {
    position: 'absolute',
    right: 14,
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(0,0,0,0.72)',
    borderWidth: 1,
    borderColor: 'rgba(212,168,83,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});