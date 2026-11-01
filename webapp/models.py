from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, Field, field_validator, model_validator


class TranscriptionOptions(BaseModel):
    engine: Literal["auto", "piano", "basic"] = "auto"
    sensitivity: int = Field(default=60, ge=10, le=90)
    min_duration_ms: int = Field(default=30, ge=20, le=500)
    merge_gap_ms: int = Field(default=20, ge=0, le=200)
    transpose: int = Field(default=0, ge=-12, le=12)
    quantize: Literal["off", "1/4", "1/8", "1/16"] = "off"
    tempo: int | None = Field(default=None, ge=40, le=240)
    sustain: bool = False
    preserve_dynamics: bool = True
    split_tracks: bool = True
    piano_range: bool = True
    start_seconds: float = Field(default=0, ge=0, le=600)
    duration_seconds: float | None = Field(default=None, gt=0, le=600)

    @model_validator(mode="after")
    def validate_range(self):
        if self.duration_seconds is not None and self.start_seconds + self.duration_seconds > 3600:
            raise ValueError("The selected audio range is too long.")
        return self


class YouTubeRequest(BaseModel):
    url: str = Field(min_length=10, max_length=2048)
    options: TranscriptionOptions = Field(default_factory=TranscriptionOptions)


class JobPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=160)
    favorite: bool | None = None

    @field_validator("title")
    @classmethod
    def clean_title(cls, value: str | None):
        if value is not None:
            value = value.strip()
            if not value:
                raise ValueError("Please enter a title.")
        return value


class RefineRequest(BaseModel):
    options: TranscriptionOptions


class Note(BaseModel):
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    pitch: int = Field(ge=0, le=127)
    velocity: int = Field(default=80, ge=1, le=127)


class DemoRequest(BaseModel):
    options: TranscriptionOptions = Field(default_factory=TranscriptionOptions)


class EditRequest(BaseModel):
    notes: list[Note] = Field(min_length=1, max_length=100000)
    title: str | None = Field(default=None, min_length=1, max_length=160)

    @field_validator("title")
    @classmethod
    def clean_edit_title(cls, value: str | None):
        if value is not None:
            value = value.strip()
            if not value:
                raise ValueError("Please enter a title.")
        return value
