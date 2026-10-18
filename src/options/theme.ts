/** Ant Design tokens for the Actspan Console workspace. */

import type { ThemeConfig } from 'antd';

export const actspanTheme: ThemeConfig = {
  token: {
    colorPrimary: '#2563eb',
    colorSuccess: '#14835d',
    colorError: '#b42332',
    colorText: '#14253a',
    colorTextSecondary: '#435673',
    colorBorder: '#cad7e8',
    colorBorderSecondary: '#e2eaf4',
    colorBgContainer: '#ffffff',
    colorBgLayout: '#f2f6fb',
    borderRadius: 6,
    fontFamily: '-apple-system, "SF Pro Text", "Segoe UI", "PingFang SC", sans-serif',
    boxShadow: '0 8px 24px rgba(20, 37, 58, .08)',
    boxShadowSecondary: '0 12px 32px rgba(20, 37, 58, .1)',
    fontSize: 13,
    controlHeight: 38,
  },
  components: {
    Layout: {
      siderBg: '#f2f6fb',
      bodyBg: '#ffffff',
      headerBg: '#14253a',
    },
    Menu: {
      itemBorderRadius: 4,
      itemSelectedBg: '#e9f0ff',
      itemSelectedColor: '#1749ae',
      itemHoverBg: '#f2f6fb',
      itemColor: '#435673',
    },
    Card: {
      borderRadiusLG: 8,
      paddingLG: 24,
      colorBorderSecondary: '#e2eaf4',
    },
    Table: {
      headerBg: '#f2f6fb',
      headerColor: '#435673',
      borderColor: '#e2eaf4',
      headerSplitColor: '#e2eaf4',
      borderRadius: 6,
      fontSize: 12,
    },
    Input: {
      borderRadius: 6,
      colorBorder: '#cad7e8',
      activeBorderColor: '#2563eb',
      hoverBorderColor: '#7c95b8',
    },
    Button: {
      borderRadius: 6,
      primaryColor: '#ffffff',
      colorPrimaryBg: '#2563eb',
      colorPrimaryBgHover: '#1749ae',
      defaultBorderColor: '#cad7e8',
      fontSize: 13,
    },
    Form: {
      labelColor: '#14253a',
      labelFontSize: 13,
      itemMarginBottom: 20,
    },
    Tag: {
      borderRadiusSM: 4,
    },
    Modal: {
      borderRadiusLG: 8,
    },
  },
};
