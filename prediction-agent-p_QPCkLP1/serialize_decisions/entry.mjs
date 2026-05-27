// Prediction Agent — serialize_decisions
//
// Takes the row array from q_score_trends and converts it to the JSON-string
// payload PROC_PREDICTION_APPLY consumes. The proc expects keys in lowercase
// snake_case; the Snowflake registry action returns column names in upper.

export default defineComponent({
  props: {
    score_rows: { type: "any" },
  },
  async run() {
    const rows = Array.isArray(this.score_rows) ? this.score_rows : [];

    const decisions = rows.map((r) => ({
      trend_id:               r.TREND_ID,
      prediction_score:       r.PREDICTION_SCORE,
      prediction_flag:        r.PREDICTION_FLAG,
      prediction_eligible:    r.PREDICTION_ELIGIBLE === true || r.PREDICTION_ELIGIBLE === "true",
      input_heat_now:         r.INPUT_HEAT_NOW,
      input_heat_7d:          r.INPUT_HEAT_7D,
      input_heat_14d:         r.INPUT_HEAT_14D,
      input_acceleration:     r.INPUT_ACCELERATION,
      input_inverse_heat:     r.INPUT_INVERSE_HEAT,
      input_sources_last_7d:  r.INPUT_SOURCES_LAST_7D,
      input_sources_prior_7d: r.INPUT_SOURCES_PRIOR_7D,
      input_source_delta:     r.INPUT_SOURCE_DELTA,
      input_signals_last_7d:  r.INPUT_SIGNALS_LAST_7D,
      input_signals_prior_7d: r.INPUT_SIGNALS_PRIOR_7D,
      input_signal_delta:     r.INPUT_SIGNAL_DELTA,
      input_score_percentile: r.INPUT_SCORE_PERCENTILE,
      days_since_promotion:   r.DAYS_SINCE_PROMOTION,
    }));

    const scored_count   = decisions.filter((d) => d.prediction_score !== null && d.prediction_score !== undefined).length;
    const eligible_count = decisions.filter((d) => d.prediction_eligible).length;

    console.log(
      `pred-serialize: rows=${decisions.length} scored=${scored_count} eligible=${eligible_count}`
    );

    return {
      decisions_json: JSON.stringify(decisions),
      total_rows:     decisions.length,
      scored_count,
      eligible_count,
      null_count:     decisions.length - scored_count,
    };
  },
});
