# Prop Layer v2

## Added modules

### Run classification
Calculates RPI and RCI, then tags the environment as power scoring, contact/sequencing, full offense, suppressed, or mixed.

### Prop translation layer
Adjusts prop recommendation scores based on environment fit. Contact games downgrade fantasy-score overs and boost HRR-style paths. Power games boost fantasy-score and HR paths.

### Line efficiency detector
When a prop has both a projection and a market line, it calculates edge percent and checks it against prop-specific thresholds.

### Role stability score
Grades hitter role safety from batting order, projected PA if available, recent starts if available, and pinch-hit risk if available.

### Late-inning equity model
Grades late scoring potential using starter shortness, bullpen weakness, bullpen fatigue if available, and lineup late-scoring index if available.
