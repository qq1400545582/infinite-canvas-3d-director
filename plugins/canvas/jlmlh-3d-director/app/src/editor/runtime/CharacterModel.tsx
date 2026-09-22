import { Component, type ReactNode } from "react";
import type { CharacterRigState } from "../schema/directorProject";
import { PrimitiveMannequin } from "./PrimitiveMannequin";
import { UE4MannequinModel } from "./UE4MannequinModel";
import type { CharacterBodyType } from "./mannequin/bodyTypes";

interface CharacterModelProps {
  bodyType?: CharacterBodyType;
  color?: string;
  onLabelAnchorYChange?: (anchorY: number) => void;
  rigState?: CharacterRigState;
  motionTime?: number;
  characterId?: string;
}

class CharacterModelBoundary extends Component<
  {
    fallback: ReactNode;
    children: ReactNode;
  },
  {
    hasError: boolean;
  }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

export function CharacterModel({ bodyType, color, onLabelAnchorYChange, rigState, motionTime, characterId }: CharacterModelProps) {
  const fallback = <PrimitiveMannequin bodyType={bodyType} color={color} rigState={rigState} motionTime={motionTime} characterId={characterId} />;

  if (rigState?.rigType !== "ue4-mannequin") {
    return fallback;
  }

  return (
    <CharacterModelBoundary fallback={fallback}>
      <UE4MannequinModel
        bodyType={bodyType}
        color={color}
        onLabelAnchorYChange={onLabelAnchorYChange}
        rigState={rigState}
        motionTime={motionTime}
        characterId={characterId}
      />
    </CharacterModelBoundary>
  );
}
