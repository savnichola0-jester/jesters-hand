import React from 'react';
import { View, Image, ScrollView, StyleSheet, Dimensions, Platform, Text, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFileTransition } from '@/contexts/FileTransition';
import { useAuth } from '@/contexts/AuthContext';
import WhisperNavIcon from '@/components/WhisperNavIcon';
import BellNavIcon from '@/components/BellNavIcon';
import { appWindow } from '@/lib/appWindow';
import SuitsTile from '@/components/suits/SuitsTile';

const { width: SW } = appWindow();
const PAD    = 10;
const GAP    = 10;
const TILE_W = Math.floor((SW - PAD * 2 - GAP) / 2);
const NAV_H  = 52;

const MARBLE   = require('../../assets/images/lace_bg.png');

// This is the public table order. Keep it deliberately explicit: the art is
// part of the navigation language, not an alphabetised application launcher.
const ALL_TILES = [
  { src: require('../../assets/images/tile_ticket.png'),        route: '/(tabs)/ticket', adminOnly: false },
  { src: require('../../assets/images/tile_the_hand.png'),      route: '/(tabs)/hand',   adminOnly: false },
  { src: require('../../assets/images/tile_6.png'),             route: '/(tabs)/street-art', adminOnly: false },
  { src: require('../../assets/images/icon_jesters_deal.png'),  route: '/(tabs)/jesters-deal', adminOnly: false },
  { suits: true,                                                 route: '/(tabs)/suits', adminOnly: false },
  { src: require('../../assets/images/tile_ante.png'),          route: '/(tabs)/ante',   adminOnly: false },
  { src: require('../../assets/images/tile_jesters_table.png'), route: '/(tabs)/table',  adminOnly: false },
  { src: require('../../assets/images/tile_target_ticket.png'), route: '/(tabs)/target-ticket', adminOnly: false },
  { src: require('../../assets/images/tile_9.png'),             route: '/(tabs)/recruit', adminOnly: false },
  { src: require('../../assets/images/tile_7.png'),             route: '/(tabs)/vault',  adminOnly: false },
  { src: require('../../assets/images/tile_8.png'),             route: '/(tabs)/chamber', adminOnly: false },
  { src: require('../../assets/images/tile_11.png'),            route: '/(tabs)/system', adminOnly: false },
  { src: require('../../assets/images/tile_10.png'),            route: '/(tabs)/uniform', adminOnly: false },
  { src: require('../../assets/images/tile_12.png'),            route: '/(tabs)/jesters-hand', adminOnly: true },
];

export default function HomeScreen() {
  const insets    = useSafeAreaInsets();
  const topInset  = Platform.OS === 'web' ? 50 : insets.top;
  const navBottom = topInset + NAV_H;
  const { navigateTo } = useFileTransition();
  const { jokerId } = useAuth();

  // Filter out admin-only tiles for regular jokers
  const tiles = ALL_TILES.filter(t => !t.adminOnly || jokerId === '00-00');

  return (
    <View style={styles.root}>
      <Image source={MARBLE} style={StyleSheet.absoluteFill} resizeMode="cover" />
      <View style={[styles.nav, { height: navBottom }]}>
        <Text style={[styles.navTitle, { bottom: 10 }]}>Jester's Hand</Text>
        <View style={[styles.navIcons, { bottom: 6 }]}>
          <WhisperNavIcon size={38} />
          <BellNavIcon size={38} />
        </View>
      </View>

      <ScrollView
        style={{ position: 'absolute', top: navBottom, left: 0, right: 0, bottom: 0 }}
        contentContainerStyle={styles.grid}
        showsVerticalScrollIndicator={false}
      >
        {tiles.map((tile, i) => (
          <TouchableOpacity
            key={i}
            onPress={() => tile.route && navigateTo(tile.route)}
            activeOpacity={tile.route ? 0.85 : 1}
          >
            {tile.suits ? <SuitsTile size={TILE_W} /> : <Image source={tile.src!} style={{ width: TILE_W, height: TILE_W }} resizeMode="contain" />}
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  nav:  { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: '#000', zIndex: 10 },
  grid:     { flexDirection: 'row', flexWrap: 'wrap', padding: PAD, gap: GAP },
  navTitle: { position: 'absolute', left: 14, color: '#EDE0C4', fontSize: 16, fontFamily: 'Cinzel_700Bold', letterSpacing: 1 },
  navIcons: { position: 'absolute', right: 12, flexDirection: 'row', alignItems: 'center', gap: 10 },
  navIcon:  { width: 38, height: 38 },
});
