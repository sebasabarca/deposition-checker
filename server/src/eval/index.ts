// Public entry point of the eval module. So far, the label file format; recall@K comes next.

export { LabelFile, LABELS, readLabelFile } from "./labels";
export { discoveryMetrics, distractors, runDiscovery, withDistractors, type DiscoveryMetrics, type DiscoveryRun, type TargetPair } from "./discovery";
export { mockCardModel, mockTopicModel } from "./mockCards";
export { DISCREPANCY_CLASSES, DiscrepancyFile, readDiscrepancyFile, scoreDiscrepancies, type DiscrepancyClass, type DiscrepancyResult, type Proposal } from "./discrepancies";
