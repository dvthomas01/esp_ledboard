import React, { type ErrorInfo, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

type Props = { children: ReactNode };

type State = { error: Error | null; info: string | null };

/**
 * Catches React render errors so a single screen bug does not white-screen the whole app.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ info: info.componentStack ?? null });
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  reset = (): void => {
    this.setState({ error: null, info: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <View style={styles.wrap}>
          <Text style={styles.title}>Something went wrong</Text>
          <ScrollView style={styles.scroll}>
            <Text style={styles.body}>{this.state.error.message}</Text>
            {this.state.info ? (
              <Text style={styles.mono}>{this.state.info}</Text>
            ) : null}
          </ScrollView>
          <Pressable style={styles.btn} onPress={this.reset}>
            <Text style={styles.btnText}>Try again</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    padding: 24,
    paddingTop: 56,
    backgroundColor: '#fef2f2',
    justifyContent: 'flex-start',
  },
  title: { fontSize: 20, fontWeight: '700', color: '#991b1b', marginBottom: 12 },
  scroll: { flex: 1, marginVertical: 8 },
  body: { fontSize: 15, color: '#444', marginBottom: 12 },
  mono: { fontSize: 11, fontFamily: 'Menlo', color: '#666' },
  btn: {
    marginTop: 20,
    alignSelf: 'flex-start',
    backgroundColor: '#2563eb',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
  },
  btnText: { color: '#fff', fontWeight: '600' },
});
