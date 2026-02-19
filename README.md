
# Quant Desk Terminal

**Next-gen institutional market terminal with sentinel logic and real-time order flow analytics.**

The Quant Desk Terminal is a high-performance React application designed for low-latency financial visualization. It integrates real-time WebSocket data from Kraken with advanced AI analysis powered by Google Gemini 3.

## Architecture

This application follows a high-performance, event-driven architecture designed for low-latency financial visualization.

```mermaid
graph TD
    User[User Interface] --> |React/Vite| Client
    
    subgraph Client [Frontend Layer]
        State[Global State (Reducer)]
        WS[WebSocket Manager]
        Chart[Lightweight Charts]
        Hooks[Custom Hooks]
    end
    
    subgraph Data [Data Sources]
        Kraken[Kraken WebSocket]
        Backend[FastAPI Python Backend]
    end
    
    subgraph Intelligence [AI & Analysis]
        Gemini[Google Gemini 3]
        Sentinel[Sentinel Logic Engine]
    end
    
    Kraken --> |Stream| WS
    WS --> State
    State --> Chart
    Hooks --> Chart
    
    Backend --> |HTTP Poll| Client
    Backend <--> Gemini
    Backend -.-> |Alerts| User
```

## Key Components

### `App.tsx`
The central controller. Manages global state via `useReducer`, handles WebSocket connections to Kraken, and coordinates the backtesting engine.
*   **State Management**: Monolithic reducer for atomic updates of market data.
*   **Data Ingestion**: Direct WebSocket connection to `wss://ws.kraken.com`.
*   **Simulation Engine**: A robust synthetic data generator used for backtesting strategies and fallback scenarios when live feeds are interrupted.
*   **ADX Logic**: Contains an optimized `O(N)` implementation of the Average Directional Index using Wilder's Smoothing.

### `components/PriceChart.tsx`
A wrapper around `lightweight-charts`.
*   **Features**: Candlestick series, Volume histogram, Custom overlays (Z-Score bands), and trade signal markers.
*   **Optimization**: Uses `requestAnimationFrame` for smooth rendering updates without blocking the main thread.

### `components/SentinelPanel.tsx`
Displays the risk management checklist.
*   **Logic**: Validates trade conditions (Skewness, Sentiment, Z-Score) before allowing execution. It serves as the primary "Go/No-Go" gauge for the desk.

### `hooks/useChart.ts`
Custom hooks for chart lifecycle management.
*   **Debounce Logic**: Handles resize events with a 75ms debounce to prevent layout thrashing on mobile devices (specifically iOS Safari).
*   **Volume Profile**: Calculates Price-by-Volume distribution in linear time.

## API Documentation

The frontend expects a backend running on `http://localhost:8000`.

### `GET /analyze`
Triggers a Gemini 3 Pro analysis of the current market structure based on recent candle history.
*   **Response**: `AiScanResult`
    *   `support`: Array of price levels.
    *   `resistance`: Array of price levels.
    *   `decision_price`: Key pivot point.
    *   `verdict`: "ENTRY", "EXIT", or "WAIT".

### `GET /market-intelligence`
Fetches news and sentiment analysis using Gemini 3 Flash.
*   **Response**: `MarketIntelResponse`
    *   `articles`: Array of news items.
    *   `intelligence`: Object containing `main_narrative` and `ai_sentiment_score`.

### `GET /bands`
Retrieves calculated Z-Score volatility bands based on the last 50 periods.
*   **Response**: Object containing `upper_1`, `lower_1`, `upper_2`, `lower_2`.

## Setup

1.  **Install Dependencies**: `npm install`
2.  **Run Dev Server**: `npm run dev`
3.  **Run Backend**: Navigate to `/backend` and run `python main.py` (requires `GEMINI_API_KEY` in `.env`).

## Theme System

The application uses a custom "True Dark" theme (`#09090b`) optimized for OLED screens and long-session usage.
*   **Primary Accent**: `#7C3AED` (Purple)
*   **Trade Bid**: `#10b981` (Emerald)
*   **Trade Ask**: `#f43f5e` (Rose)
*   **Warning**: `#f59e0b` (Amber)
