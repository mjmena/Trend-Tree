export default {
  name: "Test",
  version: "0.0.1",
  key: "test",
  description: "Emit new events on each...",
  props: {
    http: "$.interface.http",
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
