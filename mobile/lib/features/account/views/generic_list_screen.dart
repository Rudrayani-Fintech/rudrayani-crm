import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/api/api_client.dart';
import '../../../core/utils/friendly_error.dart';
import '../../../core/widgets/state_views.dart';

class GenericListScreen<T> extends ConsumerStatefulWidget {
  final String title;
  final String endpoint;
  final String dataKey;
  final Widget Function(T item) builder;
  final T Function(Map<String, dynamic>) parser;

  const GenericListScreen({
    super.key,
    required this.title,
    required this.endpoint,
    required this.dataKey,
    required this.builder,
    required this.parser,
  });

  @override
  ConsumerState<GenericListScreen<T>> createState() => _GenericListScreenState<T>();
}

class _GenericListScreenState<T> extends ConsumerState<GenericListScreen<T>> {
  List<T>? _data;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    // Backs 8 routes and previously had none of this app's shared error/
    // empty/loading treatment -- a raw 'Error: $_error' with no retry
    // button, and no way to distinguish "still loading" from "failed".
    setState(() => _error = null);
    try {
      final api = ref.read(apiClientProvider);
      final res = await api.get(widget.endpoint);
      final rawList = res.data[widget.dataKey] as List;
      if (mounted) {
        setState(() {
          _data = rawList.map((e) => widget.parser(e as Map<String, dynamic>)).toList();
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() => _error = friendlyError(e));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      body: _error != null
          ? ErrorState(message: _error!, onRetry: _load)
          : _data == null
              ? const LoadingState()
              : _data!.isEmpty
                  ? const EmptyState(message: 'No data found.')
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: ListView.builder(
                        itemCount: _data!.length,
                        itemBuilder: (context, i) => widget.builder(_data![i]),
                      ),
                    ),
    );
  }
}
