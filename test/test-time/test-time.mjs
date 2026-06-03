export default {
  name: "Test Time",
  version: "0.0.1",
  key: "test-time",
  description: "Emit new events on each...",
  props: {
    timer: "$.interface.timer",
  },
  type: "source",
  methods: {},
  async run(event) {
    this.$emit(
      { event },
      {
        summary: "Hello, world!",
        ts: Date.now(),
      }
    );
  },
};
